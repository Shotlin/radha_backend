import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';

import type {
  DateRange,
  TaskCompletionLeader,
  TeamStats,
  TopScanner,
} from '../types/dashboard.types';

import { rowAt, rowsOf, toNumber as numberOrZero } from './sql-result.utils';

/**
 * BE-30 — Team-performance leaderboards.
 *
 * Three reads:
 *   - `team_size`          : number of users with active access to the store
 *   - `active_today`       : distinct users who logged a scan today
 *   - `top_scanners`       : top 5 by scan_items count over the window
 *   - `task_leaders`       : top 5 by completed task count over the window
 *
 * Joins on `users` keep the user_name + avatar inline so the mobile
 * app gets the rendered leaderboard in one call.
 */
@Injectable()
export class TeamPerformanceService {
  constructor(private readonly db: DbService) {}

  async getTeamStats(storeId: string, dateRange: DateRange): Promise<TeamStats> {
    const conn = this.db.getDb();
    const today = startOfUtcDay(new Date());

    type CountRow = { cnt: number | string };
    type ScannerRow = {
      user_id: string;
      user_name: string | null;
      scan_count: number | string;
    };
    type LeaderRow = {
      user_id: string;
      user_name: string | null;
      completed_count: number | string;
      assigned_count: number | string;
    };

    const [teamSizeRes, activeRes, topScannersRes, leaderboardRes] = await Promise.all([
      conn.execute<CountRow>(sql`
        SELECT count(DISTINCT user_id)::int AS cnt
        FROM user_store_access
        WHERE store_id = ${storeId}
          AND is_active = true
      `),
      conn.execute<CountRow>(sql`
        SELECT count(DISTINCT user_id)::int AS cnt
        FROM scan_items
        WHERE store_id = ${storeId}
          AND deleted_at IS NULL
          AND scanned_at >= ${today}
      `),
      conn.execute<ScannerRow>(sql`
        SELECT s.user_id, u.name AS user_name, count(*)::int AS scan_count
        FROM scan_items s
        LEFT JOIN users u ON u.id = s.user_id
        WHERE s.store_id = ${storeId}
          AND s.deleted_at IS NULL
          AND s.scanned_at >= ${dateRange.from}
          AND s.scanned_at <  ${dateRange.to}
        GROUP BY s.user_id, u.name
        ORDER BY scan_count DESC
        LIMIT 5
      `),
      conn.execute<LeaderRow>(sql`
        SELECT a.assignee_id AS user_id,
               u.name AS user_name,
               count(*) FILTER (WHERE t.status = 'completed' AND t.completed_at >= ${dateRange.from} AND t.completed_at < ${dateRange.to})::int AS completed_count,
               count(*) FILTER (WHERE t.created_at >= ${dateRange.from} AND t.created_at < ${dateRange.to})::int                                  AS assigned_count
        FROM task_assignments a
        JOIN tasks t ON t.id = a.task_id
        LEFT JOIN users u ON u.id = a.assignee_id
        WHERE t.store_id = ${storeId}
          AND t.deleted_at IS NULL
          AND a.revoked_at IS NULL
        GROUP BY a.assignee_id, u.name
        ORDER BY completed_count DESC
        LIMIT 5
      `),
    ]);

    const totalMembers = numberOrZero(rowAt<CountRow>(teamSizeRes, 0)?.cnt);
    const activeToday = numberOrZero(rowAt<CountRow>(activeRes, 0)?.cnt);

    const topScanners: TopScanner[] = rowsOf<ScannerRow>(topScannersRes).map((row) => ({
      userId: row.user_id,
      userName: row.user_name ?? 'Unknown user',
      scanCount: numberOrZero(row.scan_count),
    }));

    const taskCompletionLeaders: TaskCompletionLeader[] = rowsOf<LeaderRow>(leaderboardRes).map(
      (row) => {
        const completed = numberOrZero(row.completed_count);
        const assigned = numberOrZero(row.assigned_count);
        const completionRate = assigned > 0 ? Math.round((completed / assigned) * 100) : 0;
        return {
          userId: row.user_id,
          userName: row.user_name ?? 'Unknown user',
          completedCount: completed,
          completionRate,
        };
      },
    );

    return {
      totalMembers,
      activeToday,
      topScanners,
      taskCompletionLeaders,
    };
  }
}

function startOfUtcDay(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}
