import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import {
  ImpersonationSessionRow,
  NewImpersonationSession,
  impersonationSessions,
} from '@/db/schema/impersonation';

/**
 * BE-53 — Drizzle repository for `impersonation_sessions`.
 *
 * Pure data-access. The 60-minute cap, reason validation, and
 * destructive-action policing live in `AdminImpersonationService` /
 * `ImpersonationGuard`.
 */
@Injectable()
export class ImpersonationSessionsRepository {
  constructor(private readonly db: DbService) {}

  /** Insert a new session row. The DB defaults `expiresAt` to now() + 60m. */
  async create(data: NewImpersonationSession): Promise<ImpersonationSessionRow> {
    const [row] = await this.db
      .getDb()
      .insert(impersonationSessions)
      .values(data)
      .returning();
    return row;
  }

  /** Look up a single session row by its id. Used by the action logger + guard. */
  async findById(id: string): Promise<ImpersonationSessionRow | null> {
    const rows = await this.db
      .getDb()
      .select()
      .from(impersonationSessions)
      .where(eq(impersonationSessions.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Returns the row only if it's still live — `ended_at IS NULL`
   * AND `expires_at > now()`. The action logger / guard call this
   * to confirm a JWT-claimed session is still valid before honouring
   * the impersonation context on a request.
   */
  async findActiveById(id: string): Promise<ImpersonationSessionRow | null> {
    const rows = await this.db
      .getDb()
      .select()
      .from(impersonationSessions)
      .where(
        and(
          eq(impersonationSessions.id, id),
          isNull(impersonationSessions.endedAt),
          sql`${impersonationSessions.expiresAt} > now()`,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The "currently open" session for a given staff user. There can
   * be more than one (concurrent sessions are allowed by spec) — we
   * return the most recent one for the `DELETE /impersonate` "end
   * current session" semantic.
   */
  async findLatestActiveByStaff(staffUserId: string): Promise<ImpersonationSessionRow | null> {
    const rows = await this.db
      .getDb()
      .select()
      .from(impersonationSessions)
      .where(
        and(
          eq(impersonationSessions.staffUserId, staffUserId),
          isNull(impersonationSessions.endedAt),
          sql`${impersonationSessions.expiresAt} > now()`,
        ),
      )
      .orderBy(desc(impersonationSessions.startedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Soft-end the session: stamps `ended_at = now()` and the supplied
   * reason. Returns the updated row, or null if nothing matched
   * (already ended, never existed, etc.).
   */
  async endSession(
    id: string,
    endedReason: string,
  ): Promise<ImpersonationSessionRow | null> {
    const [row] = await this.db
      .getDb()
      .update(impersonationSessions)
      .set({ endedAt: new Date(), endedReason })
      .where(and(eq(impersonationSessions.id, id), isNull(impersonationSessions.endedAt)))
      .returning();
    return row ?? null;
  }

  /**
   * Audit listing for `GET /api/v1/admin/impersonations/audit`.
   * Newest-first, optional bounds.
   */
  async list(
    options: {
      staffUserId?: string;
      impersonatedUserId?: string;
      limit?: number;
    } = {},
  ): Promise<ImpersonationSessionRow[]> {
    const conditions = [];
    if (options.staffUserId) {
      conditions.push(eq(impersonationSessions.staffUserId, options.staffUserId));
    }
    if (options.impersonatedUserId) {
      conditions.push(eq(impersonationSessions.impersonatedUserId, options.impersonatedUserId));
    }
    const limit = Math.max(1, Math.min(500, options.limit ?? 100));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    return this.db
      .getDb()
      .select()
      .from(impersonationSessions)
      .where(where ?? sql`true`)
      .orderBy(desc(impersonationSessions.startedAt))
      .limit(limit);
  }
}
