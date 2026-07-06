import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, lte } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewReportSchedule, ReportScheduleRow, reportSchedules } from '@/db/schema/reports';

import type { ReportScheduleStatus } from '../types/report.types';

@Injectable()
export class ReportSchedulesRepository extends BaseRepository<
  typeof reportSchedules,
  ReportScheduleRow,
  NewReportSchedule,
  Partial<NewReportSchedule>
> {
  constructor(db: DbService) {
    super(db.getDb(), reportSchedules, 'report_schedules');
  }

  async findByIdInTenant(id: string, tenantId: string): Promise<ReportScheduleRow | null> {
    const [row] = await this.db
      .select()
      .from(reportSchedules)
      .where(
        and(
          eq(reportSchedules.id, id),
          eq(reportSchedules.tenantId, tenantId),
          isNull(reportSchedules.deletedAt),
        ),
      )
      .limit(1);
    return (row as ReportScheduleRow | undefined) ?? null;
  }

  async listForTenant(tenantId: string, limit: number): Promise<ReportScheduleRow[]> {
    return (await this.db
      .select()
      .from(reportSchedules)
      .where(and(eq(reportSchedules.tenantId, tenantId), isNull(reportSchedules.deletedAt)))
      .orderBy(asc(reportSchedules.nextRunAt))
      .limit(limit)) as ReportScheduleRow[];
  }

  async findDueAt(now: Date, limit = 100): Promise<ReportScheduleRow[]> {
    return (await this.db
      .select()
      .from(reportSchedules)
      .where(
        and(
          eq(reportSchedules.status, 'active' as ReportScheduleStatus),
          lte(reportSchedules.nextRunAt, now),
          isNull(reportSchedules.deletedAt),
        ),
      )
      .orderBy(asc(reportSchedules.nextRunAt))
      .limit(limit)) as ReportScheduleRow[];
  }
}
