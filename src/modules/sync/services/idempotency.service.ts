import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import type {
  IdempotencyRecordRow,
  NewIdempotencyRecord,
} from '@/db/schema/idempotency-records';

import { IdempotencyRecordsRepository } from '../repositories/idempotency-records.repository';

/**
 * BE-44 — Idempotency record service.
 *
 * Wraps the repository with the small bit of business logic that the
 * middleware needs:
 *   - hashing requests into a stable fingerprint,
 *   - looking up fresh records,
 *   - persisting captured responses best-effort (logging on failure).
 *
 * Hashing strategy:
 *   `sha256(METHOD || PATH || stableJSON(body))` — query string is
 *   deliberately excluded because Mobile_App may add tracing params on
 *   retry that don't change the mutation's intent.
 */

export interface IdempotencyHashInput {
  method: string;
  path: string;
  body: unknown;
}

export interface CapturedResponse {
  status: number;
  body: unknown;
}

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly repo: IdempotencyRecordsRepository) {}

  /**
   * Fingerprint a mutating request. Stable across JSON key order so
   * `{"a":1,"b":2}` and `{"b":2,"a":1}` collide as expected.
   */
  hashRequest(input: IdempotencyHashInput): string {
    const canonical = stableStringify(input.body ?? null);
    const material = `${input.method.toUpperCase()}\n${input.path}\n${canonical}`;
    return createHash('sha256').update(material).digest('hex');
  }

  /**
   * Look up an existing fresh record. Returns `null` if missing or
   * expired.
   */
  async lookup(key: string): Promise<IdempotencyRecordRow | null> {
    return this.repo.findFreshByKey(key);
  }

  /**
   * Persist a captured response under the given key. Best-effort — DB
   * failures are logged and swallowed so a failed cache-write never
   * tanks an otherwise successful mutation.
   */
  async persist(args: {
    key: string;
    userId: string;
    requestHash: string;
    response: CapturedResponse;
  }): Promise<IdempotencyRecordRow | null> {
    const record: NewIdempotencyRecord = {
      key: args.key,
      userId: args.userId,
      requestHash: args.requestHash,
      responseStatus: args.response.status,
      responseBody: args.response.body ?? {},
    };
    try {
      return await this.repo.insertIfMissing(record);
    } catch (err) {
      this.logger.warn(
        `Failed to persist idempotency record key=${args.key}: ${(err as Error).message}`,
      );
      return null;
    }
  }
}

/**
 * Deterministic JSON.stringify that sorts object keys recursively so
 * payload hashes are stable regardless of property order. Arrays keep
 * their order — element position is meaningful.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}
