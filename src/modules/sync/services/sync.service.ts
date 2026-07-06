import { Injectable, Logger } from '@nestjs/common';

import {
  SyncBatchDto,
  SyncBatchResultDto,
  SyncFailedItem,
  SyncItemDto,
  SyncProcessedItem,
} from '../dto/sync-batch.dto';
import {
  SyncChangesQueryDto,
  SyncChangesResponseDto,
} from '../dto/sync-changes.dto';
import {
  LamportTimestamp,
  compareLamport,
  parseLamport,
} from '../utils/lamport-clock.util';

/**
 * BE-44 — Bulk sync orchestrator.
 *
 * Responsibilities:
 *   - Iterate batch items and dispatch to per-resource handlers.
 *   - Build a `processed` / `failed` map so a single bad row doesn't
 *     fail the whole batch — Mobile_App can retry just the failures.
 *   - Apply last-write-wins by Lamport timestamp when a resource ships
 *     a `currentVersion` for the same id.
 *   - Honour the server-wins list for security-sensitive fields
 *     (`subscriptions.tier`, `subscriptions.status`, `users.role`,
 *     `users.email_verified`); incoming values for those keys are
 *     stripped before any write.
 *
 * Wiring to the real domain modules (scans, saved-products, allergen-
 * profiles) is intentionally stubbed: the orchestrator returns success
 * for every well-formed item so the contract is testable today and
 * downstream modules can plug in without touching this file.
 */

export type SyncResource = 'scans' | 'saved-products' | 'allergen-profiles';

/** Fields the server always wins on regardless of what the client sent. */
export const SERVER_WINS_FIELDS = Object.freeze({
  subscriptions: ['tier', 'status'] as readonly string[],
  users: ['role', 'email_verified', 'emailVerified'] as readonly string[],
});

export interface SyncContext {
  tenantId: string | null;
  userId: string;
  resource: SyncResource;
}

export interface SyncSingleItemResult {
  status: SyncProcessedItem['status'];
  id?: string;
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  /** Track the highest Lamport timestamp seen per (resource, id) in this batch. */
  private highWaterMarks = new WeakMap<object, Map<string, LamportTimestamp | null>>();

  /**
   * Process a batch of sync items. Per-item failures are collected
   * and never throw out of the orchestrator; the whole call only
   * fails if the batch envelope itself is unprocessable (caught by
   * the controller before reaching us).
   */
  async processBatch(
    batch: SyncBatchDto,
    context: SyncContext,
  ): Promise<SyncBatchResultDto> {
    const processed: SyncProcessedItem[] = [];
    const failed: SyncFailedItem[] = [];
    const seenKeys = new Set<string>();
    const watermarks = new Map<string, LamportTimestamp | null>();
    this.highWaterMarks.set(batch, watermarks);

    for (let index = 0; index < batch.items.length; index += 1) {
      const item = batch.items[index];
      try {
        if (seenKeys.has(item.idempotencyKey)) {
          processed.push({
            index,
            idempotencyKey: item.idempotencyKey,
            status: 'noop',
          });
          continue;
        }
        seenKeys.add(item.idempotencyKey);

        const sanitised = this.stripServerWinsFields(item.payload, context.resource);
        const lamport = parseLamport(item.lamportTimestamp ?? null);

        // Apply intra-batch last-write-wins per logical id when the
        // item carries an id.
        const id = typeof sanitised.id === 'string' ? sanitised.id : undefined;
        if (id) {
          const previous = watermarks.get(id) ?? null;
          if (compareLamport(lamport, previous) < 0) {
            processed.push({
              index,
              idempotencyKey: item.idempotencyKey,
              status: 'noop',
              id,
            });
            continue;
          }
          watermarks.set(id, lamport);
        }

        const result = await this.dispatch(context, { ...item, payload: sanitised });
        processed.push({
          index,
          idempotencyKey: item.idempotencyKey,
          status: result.status,
          id: result.id,
        });
      } catch (err) {
        const error = err as Error;
        this.logger.warn(
          `Sync item ${index} failed (${context.resource}): ${error.message}`,
        );
        failed.push({
          index,
          idempotencyKey: item.idempotencyKey,
          error: {
            code: (error as { code?: string }).code ?? 'SYNC_ITEM_FAILED',
            message: error.message,
          },
        });
      }
    }

    return {
      processed,
      failed,
      total: batch.items.length,
    };
  }

  /**
   * `GET /sync/changes` — server-pull endpoint.
   *
   * Stub implementation: returns no changes and a null cursor so the
   * Mobile_App's catch-up loop terminates. Real wiring will plug into
   * each domain module's `findChangesSince` query in a follow-up
   * phase, sharded by `resource`.
   */
  async getChanges(
    _context: { tenantId: string | null; userId: string },
    query: SyncChangesQueryDto,
  ): Promise<SyncChangesResponseDto> {
    // Surface the parsed limit so the future implementation is just a
    // "swap the empty list" change. Logged for observability today.
    this.logger.debug(
      `sync.changes since=${query.since ?? 'null'} cursor=${query.cursor ?? 'null'} limit=${query.limit ?? 'default'}`,
    );

    return {
      changes: [],
      nextCursor: null,
      serverTime: new Date().toISOString(),
    };
  }

  /**
   * Dispatch a single item to its per-resource handler. Today every
   * handler returns `created` so the contract is exercised end-to-end;
   * downstream modules will replace these stubs with real writes.
   */
  private async dispatch(
    context: SyncContext,
    item: SyncItemDto,
  ): Promise<SyncSingleItemResult> {
    switch (context.resource) {
      case 'scans':
        return this.processScan(context, item);
      case 'saved-products':
        return this.processSavedProduct(context, item);
      case 'allergen-profiles':
        return this.processAllergenProfile(context, item);
      default: {
        const exhaustive: never = context.resource;
        throw new Error(`Unsupported sync resource: ${String(exhaustive)}`);
      }
    }
  }

  private async processScan(
    _context: SyncContext,
    item: SyncItemDto,
  ): Promise<SyncSingleItemResult> {
    // Stub — wired to ScansModule in a follow-up. Echo back any client
    // id so the response is shaped like the real implementation.
    const id =
      typeof item.payload.id === 'string'
        ? item.payload.id
        : typeof item.payload.clientId === 'string'
          ? item.payload.clientId
          : undefined;
    return { status: 'created', id };
  }

  private async processSavedProduct(
    _context: SyncContext,
    item: SyncItemDto,
  ): Promise<SyncSingleItemResult> {
    const id = typeof item.payload.id === 'string' ? item.payload.id : undefined;
    return { status: 'created', id };
  }

  private async processAllergenProfile(
    _context: SyncContext,
    item: SyncItemDto,
  ): Promise<SyncSingleItemResult> {
    const id = typeof item.payload.id === 'string' ? item.payload.id : undefined;
    return { status: 'created', id };
  }

  /**
   * Strip server-wins fields from the payload when the resource is
   * one whose security-sensitive columns we lock down. Today only the
   * top-level `subscriptions` / `users` shapes have entries, but the
   * map is exported so other modules can reuse it.
   */
  private stripServerWinsFields(
    payload: Record<string, unknown>,
    _resource: SyncResource,
  ): Record<string, unknown> {
    const cleaned: Record<string, unknown> = { ...payload };

    const sub = cleaned.subscription;
    if (sub && typeof sub === 'object') {
      const safeSub: Record<string, unknown> = { ...(sub as Record<string, unknown>) };
      for (const field of SERVER_WINS_FIELDS.subscriptions) {
        delete safeSub[field];
      }
      cleaned.subscription = safeSub;
    }

    const user = cleaned.user;
    if (user && typeof user === 'object') {
      const safeUser: Record<string, unknown> = { ...(user as Record<string, unknown>) };
      for (const field of SERVER_WINS_FIELDS.users) {
        delete safeUser[field];
      }
      cleaned.user = safeUser;
    }

    // Top-level convenience: some clients send `tier`/`role` flat. We
    // strip those too so the rule is uniform.
    for (const field of SERVER_WINS_FIELDS.subscriptions) {
      if (field in cleaned) delete cleaned[field];
    }
    for (const field of SERVER_WINS_FIELDS.users) {
      if (field in cleaned) delete cleaned[field];
    }

    return cleaned;
  }
}
