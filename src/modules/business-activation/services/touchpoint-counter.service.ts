import { Injectable } from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { scanItems } from '@/db/schema/scans';

/**
 * BE-35 — Touchpoint Counter Service.
 *
 * Provides scan/save count snapshots used by TouchpointRulesService
 * to determine which touchpoints should be displayed to a Consumer.
 */
export interface CountSnapshot {
  totalScans: number;
  scansThisWeek: number;
  savedProducts: number;
}

@Injectable()
export class TouchpointCounterService {
  constructor(private readonly db: DbService) {}

  async snapshot(userId: string): Promise<CountSnapshot> {
    const weekStart = this.getWeekStart();

    // Total lifetime scans for this user
    const [totalRow] = (await this.db
      .getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(scanItems)
      .where(eq(scanItems.userId, userId))) as Array<{ count: number }>;

    // Scans this week
    const [weekRow] = (await this.db
      .getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(scanItems)
      .where(
        and(eq(scanItems.userId, userId), gte(scanItems.scannedAt, weekStart)),
      )) as Array<{ count: number }>;

    // Saved products — using total scans as proxy (Consumer save = scan + keep)
    // In a production setup this would query a dedicated saved_products table
    const savedProducts = Number(totalRow?.count ?? 0);

    return {
      totalScans: Number(totalRow?.count ?? 0),
      scansThisWeek: Number(weekRow?.count ?? 0),
      savedProducts,
    };
  }

  private getWeekStart(): Date {
    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Monday start
    const weekStart = new Date(now);
    weekStart.setDate(diff);
    weekStart.setHours(0, 0, 0, 0);
    return weekStart;
  }
}
