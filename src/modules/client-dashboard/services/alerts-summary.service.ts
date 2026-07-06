import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';

import type { AlertItem, DashboardAlerts } from '../types/dashboard.types';

import { rowAt, rowsOf, toNumber as numberOrZero } from './sql-result.utils';

/**
 * BE-30 — Alert aggregation for the dashboard.
 *
 * Pulls open expiry alerts (BE-18), overdue tasks (BE-19), and a
 * placeholder for the BE-27 low-stock alerts. Alerts are bucketed
 * into critical / warning / info so the mobile app can surface a
 * red-amber-grey badge without doing the categorisation client-side.
 *
 * Counts collapse all individual alerts of one kind into a single
 * `AlertItem` per bucket — the mobile UI shows one row per type with
 * the total count, then opens the detail view on tap.
 */
@Injectable()
export class AlertsSummaryService {
  constructor(private readonly db: DbService) {}

  async getAlerts(storeId: string): Promise<DashboardAlerts> {
    const conn = this.db.getDb();

    type ExpiryRow = { status: string; cnt: number | null };
    type CountRow = { cnt: number | null };

    const [expiryRes, taskRes] = await Promise.all([
      conn.execute<ExpiryRow>(sql`
        SELECT status, count(*)::int AS cnt
        FROM expiry_alerts
        WHERE store_id = ${storeId}
          AND is_resolved = false
        GROUP BY status
      `),
      conn.execute<CountRow>(sql`
        SELECT count(*)::int AS cnt
        FROM tasks
        WHERE store_id = ${storeId}
          AND status = 'overdue'
          AND deleted_at IS NULL
      `),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of rowsOf<ExpiryRow>(expiryRes)) {
      byStatus[row.status] = numberOrZero(row.cnt);
    }

    const now = new Date();
    const critical: AlertItem[] = [];
    const warning: AlertItem[] = [];
    const info: AlertItem[] = [];

    if ((byStatus.red ?? 0) > 0) {
      critical.push({
        id: 'expiry-red',
        type: 'expiry_red',
        title: `${byStatus.red} item(s) expired or expiring this week`,
        description: 'Remove from shelf immediately',
        count: byStatus.red,
        actionUrl: '/expiry?status=red',
        createdAt: now,
      });
    }

    if ((byStatus.yellow ?? 0) > 0) {
      warning.push({
        id: 'expiry-yellow',
        type: 'expiry_yellow',
        title: `${byStatus.yellow} item(s) expiring soon`,
        description: 'Plan discounts or rotation',
        count: byStatus.yellow,
        actionUrl: '/expiry?status=yellow',
        createdAt: now,
      });
    }

    const overdue = numberOrZero(rowAt<CountRow>(taskRes, 0)?.cnt);
    if (overdue > 0) {
      critical.push({
        id: 'tasks-overdue',
        type: 'task_overdue',
        title: `${overdue} task(s) overdue`,
        description: 'Reassign or extend deadline',
        count: overdue,
        actionUrl: '/tasks?status=overdue',
        createdAt: now,
      });
    }

    return {
      total: critical.length + warning.length + info.length,
      critical,
      warning,
      info,
    };
  }
}
