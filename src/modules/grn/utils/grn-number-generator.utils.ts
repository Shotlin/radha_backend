import { Injectable } from '@nestjs/common';
import { and, desc, eq, like } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { grnHeaders } from '@/db/schema/grn';

/**
 * BE-26 — GRN number generator.
 *
 * Format: `GRN-<store6>-YYYYMM-NNNN`
 *   - `store6`  : first 6 chars of the storeId UUID (no hyphens, lower-case).
 *                 Six characters give 16M distinct prefixes — vastly more than
 *                 the ~10K-store target scale.
 *   - `YYYYMM`  : the inward-month bucket. Numbering is reset every month so
 *                 sequence numbers stay short and human-readable.
 *   - `NNNN`    : 4-digit zero-padded sequence within the (tenant, prefix)
 *                 bucket. The DB-level `uniq_grn_number_tenant` index guards
 *                 against collisions if two clients race; we read-then-bump
 *                 inside the surrounding transaction.
 *
 * Rolls to 5+ digits if a tenant somehow crosses 9999 GRNs in one month — at
 * the target scale that's unreachable, but the format degrades gracefully
 * (`-12345` is still parseable).
 */
@Injectable()
export class GrnNumberGenerator {
  constructor(private readonly db: DbService) {}

  /**
   * Pure helper, exposed for unit tests so callers can verify the
   * format without going to the DB. Production code uses
   * `generateForStore`.
   */
  static buildPrefix(storeId: string, when: Date): string {
    const storePart = storeId.replace(/-/g, '').slice(0, 6).toLowerCase();
    const yyyy = when.getUTCFullYear().toString();
    const mm = String(when.getUTCMonth() + 1).padStart(2, '0');
    return `GRN-${storePart}-${yyyy}${mm}`;
  }

  static formatNumber(prefix: string, sequence: number): string {
    const padded = sequence.toString().padStart(4, '0');
    return `${prefix}-${padded}`;
  }

  /**
   * Reads the highest sequence under the prefix and returns the next.
   * Designed to be called inside a serializable transaction so the
   * read-then-insert is collision-safe; if a collision still happens
   * (e.g. across different transactions on different connections)
   * the unique index will trip and the caller should retry.
   */
  async generateForStore(
    tenantId: string,
    storeId: string,
    when: Date = new Date(),
  ): Promise<string> {
    const prefix = GrnNumberGenerator.buildPrefix(storeId, when);
    const next = await this.peekNextSequence(tenantId, prefix);
    return GrnNumberGenerator.formatNumber(prefix, next);
  }

  /**
   * Visible for testing — returns the next sequence number that
   * would be assigned under `prefix` for `tenantId`.
   */
  async peekNextSequence(tenantId: string, prefix: string): Promise<number> {
    const rows = await this.db
      .getDb()
      .select({ grnNumber: grnHeaders.grnNumber })
      .from(grnHeaders)
      .where(and(eq(grnHeaders.tenantId, tenantId), like(grnHeaders.grnNumber, `${prefix}-%`)))
      .orderBy(desc(grnHeaders.grnNumber))
      .limit(1);

    if (rows.length === 0) return 1;
    const last = rows[0].grnNumber;
    const tail = last.slice(prefix.length + 1);
    const parsed = Number.parseInt(tail, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed + 1 : 1;
  }
}
