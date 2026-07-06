import { Injectable } from '@nestjs/common';

import { DbService } from '../db.service';

export interface DatabaseHealthResult {
  status: 'ok' | 'down';
  latencyMs?: number;
  error?: string;
}

/**
 * Lightweight DB health probe.
 *
 * We deliberately don't pull in `@nestjs/terminus` here — BE-01 keeps
 * the health endpoints minimal and Terminus would force a heavier
 * controller refactor for nothing. The probe runs a `SELECT 1` and
 * times it; the readiness controller (BE-05 update) calls this and
 * surfaces it under `checks.database`.
 */
@Injectable()
export class DatabaseHealthIndicator {
  constructor(private readonly db: DbService) {}

  async check(): Promise<DatabaseHealthResult> {
    const start = Date.now();
    try {
      const ok = await this.db.ping();
      const latencyMs = Date.now() - start;
      return ok ? { status: 'ok', latencyMs } : { status: 'down', latencyMs };
    } catch (err) {
      return { status: 'down', latencyMs: Date.now() - start, error: (err as Error).message };
    }
  }
}
