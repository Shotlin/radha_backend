import { Injectable } from '@nestjs/common';

import { redactPII } from '@/common/utils/redact.utils';
import { LoggerService } from '@/logging/logger.service';

import { AppUsageEventsRepository } from '../repositories/app-usage-events.repository';
import type {
  DateRange,
  IAppAnalyticsService,
  TenantActivity,
  TrackAppEventInput,
  UserActivity,
} from '../types/analytics.types';
import { toIsoDate } from '../utils/date-range.util';

/**
 * BE-29 — Authenticated mobile-app analytics service.
 *
 * Tenant scoping is enforced at every entry point — both the
 * controller-side (`@RequireTenant()`) and here at the service so a
 * mis-wired guard can't smuggle events into the wrong tenant. The
 * `tenantId` we persist comes from the bearer token, never from the
 * client payload.
 */
@Injectable()
export class AppAnalyticsService implements IAppAnalyticsService {
  constructor(
    private readonly repo: AppUsageEventsRepository,
    private readonly appLogger: LoggerService,
  ) {}

  async trackEvent(input: TrackAppEventInput, userId: string, tenantId: string): Promise<void> {
    if (!tenantId) {
      throw new Error('tenantId is required for app event tracking');
    }
    await this.repo.create(this.buildRow(input, userId, tenantId));
    this.appLogger.info('analytics.app.event', {
      eventType: input.eventType,
      category: input.category,
      action: input.action,
    });
  }

  async trackBatch(
    inputs: TrackAppEventInput[],
    userId: string,
    tenantId: string,
  ): Promise<{ accepted: number }> {
    if (!tenantId) {
      throw new Error('tenantId is required for app event tracking');
    }
    if (inputs.length === 0) return { accepted: 0 };
    const rows = inputs.map((i) => this.buildRow(i, userId, tenantId));
    const accepted = await this.repo.insertMany(rows);
    return { accepted };
  }

  async getUserActivity(
    userId: string,
    tenantId: string,
    dateRange: DateRange,
  ): Promise<UserActivity> {
    const result = await this.repo.getUserActivity(userId, tenantId, dateRange.from, dateRange.to);
    return { userId, ...result };
  }

  async getTenantActivity(tenantId: string, dateRange: DateRange): Promise<TenantActivity> {
    const result = await this.repo.getTenantActivity(tenantId, dateRange.from, dateRange.to);
    return { tenantId, ...result };
  }

  private buildRow(input: TrackAppEventInput, userId: string, tenantId: string) {
    const metadata = input.metadata ? redactPII(input.metadata) : null;
    return {
      tenantId,
      userId,
      storeId: input.storeId ?? null,
      eventType: input.eventType,
      category: input.category.slice(0, 50),
      action: input.action.slice(0, 100),
      label: input.label?.slice(0, 200) ?? null,
      value: input.value !== undefined ? String(input.value) : null,
      screen: input.screen?.slice(0, 100) ?? null,
      appVersion: input.appVersion?.slice(0, 20) ?? null,
      platform: input.platform?.slice(0, 10) ?? null,
      deviceModel: input.deviceModel?.slice(0, 100) ?? null,
      yearMonthDay: toIsoDate(new Date()),
      metadata,
    };
  }
}
