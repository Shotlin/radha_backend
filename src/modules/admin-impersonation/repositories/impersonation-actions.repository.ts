import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import {
  ImpersonationActionRow,
  NewImpersonationAction,
  impersonationActions,
} from '@/db/schema/impersonation';

/**
 * BE-53 — Drizzle repository for `impersonation_actions`.
 *
 * Writes are issued from `ImpersonationActionLoggerMiddleware` on
 * every request that runs under an impersonation session. Reads are
 * for the audit endpoint that shows what staff touched.
 */
@Injectable()
export class ImpersonationActionsRepository {
  constructor(private readonly db: DbService) {}

  /** Persist a single action row. Best-effort; failures are logged upstream. */
  async create(data: NewImpersonationAction): Promise<ImpersonationActionRow> {
    const [row] = await this.db.getDb().insert(impersonationActions).values(data).returning();
    return row;
  }

  /** Per-session timeline for the audit drilldown UI. Chronological. */
  async listBySession(sessionId: string, limit = 500): Promise<ImpersonationActionRow[]> {
    const cap = Math.max(1, Math.min(2000, limit));
    return this.db
      .getDb()
      .select()
      .from(impersonationActions)
      .where(eq(impersonationActions.sessionId, sessionId))
      .orderBy(asc(impersonationActions.occurredAt))
      .limit(cap);
  }
}
