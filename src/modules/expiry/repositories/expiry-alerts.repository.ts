import { Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import type { Transaction } from '@/db/connection';
import { ExpiryAlertRow, NewExpiryAlert, expiryAlerts } from '@/db/schema/expiry';

@Injectable()
export class ExpiryAlertsRepository extends BaseRepository<
  typeof expiryAlerts,
  ExpiryAlertRow,
  NewExpiryAlert,
  Partial<NewExpiryAlert>
> {
  constructor(db: DbService) {
    super(db.getDb(), expiryAlerts, 'expiry_alerts');
  }

  async findByIdInTenant(id: string, tenantId: string): Promise<ExpiryAlertRow | null> {
    const [row] = await this.db
      .select()
      .from(expiryAlerts)
      .where(and(eq(expiryAlerts.id, id), eq(expiryAlerts.tenantId, tenantId)))
      .limit(1);
    return (row as ExpiryAlertRow | undefined) ?? null;
  }

  async listForStore(
    tenantId: string,
    storeId: string,
    filters: { acknowledged?: boolean; resolved?: boolean; limit: number },
  ): Promise<ExpiryAlertRow[]> {
    const conditions = [eq(expiryAlerts.tenantId, tenantId), eq(expiryAlerts.storeId, storeId)];
    if (filters.acknowledged !== undefined) {
      conditions.push(eq(expiryAlerts.isAcknowledged, filters.acknowledged));
    }
    if (filters.resolved !== undefined) {
      conditions.push(eq(expiryAlerts.isResolved, filters.resolved));
    }
    return (await this.db
      .select()
      .from(expiryAlerts)
      .where(and(...conditions))
      .orderBy(desc(expiryAlerts.createdAt))
      .limit(filters.limit)) as ExpiryAlertRow[];
  }

  async findActive(tenantId: string, storeId: string, limit = 200): Promise<ExpiryAlertRow[]> {
    return this.listForStore(tenantId, storeId, {
      resolved: false,
      limit,
    });
  }

  async findActiveByRecord(
    expiryRecordId: string,
    status: 'yellow' | 'red',
  ): Promise<ExpiryAlertRow | null> {
    const [row] = await this.db
      .select()
      .from(expiryAlerts)
      .where(
        and(
          eq(expiryAlerts.expiryRecordId, expiryRecordId),
          eq(expiryAlerts.status, status),
          eq(expiryAlerts.isResolved, false),
        ),
      )
      .limit(1);
    return (row as ExpiryAlertRow | undefined) ?? null;
  }

  async insertIfMissing(data: NewExpiryAlert, tx?: Transaction): Promise<ExpiryAlertRow | null> {
    const scope = tx ?? this.db;
    const rows = (await scope
      .insert(expiryAlerts)
      .values(data)
      .onConflictDoNothing({
        target: [expiryAlerts.expiryRecordId, expiryAlerts.status],
      })
      .returning()) as ExpiryAlertRow[];
    return rows[0] ?? null;
  }

  async resolveAllForRecord(
    expiryRecordId: string,
    userId: string,
    resolution: ExpiryAlertRow['resolution'],
    tx?: Transaction,
  ): Promise<number> {
    const scope = tx ?? this.db;
    const result = await scope
      .update(expiryAlerts)
      .set({
        isResolved: true,
        resolvedBy: userId,
        resolvedAt: new Date(),
        resolution,
        updatedAt: new Date(),
      })
      .where(
        and(eq(expiryAlerts.expiryRecordId, expiryRecordId), eq(expiryAlerts.isResolved, false)),
      )
      .returning({ id: expiryAlerts.id });
    return (result as Array<{ id: string }>).length;
  }
}
