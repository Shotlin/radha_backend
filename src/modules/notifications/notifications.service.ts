import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { DomainNotFoundException } from '@/common/errors/business.exception';
import type { NotificationRow } from '@/db/schema/notifications';
import { decodeCursor, encodeCursor } from '@/db/repositories/pagination.utils';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import { DeviceTokensRepository } from './repositories/device-tokens.repository';
import { NotificationsRepository } from './repositories/notifications.repository';
import { NotificationRouterService } from './services/notification-router.service';
import { PreferenceManagerService } from './services/preference-manager.service';
import { TemplateRendererService } from './services/template-renderer.service';
import { DEFAULT_TEMPLATES } from './templates/default-templates';
import {
  NOTIFICATIONS_QUEUE_TOKEN,
  type BulkNotificationResult,
  type ChannelDeliveryResult,
  type HistoryFilters,
  type INotificationsService,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationPreferences,
  type NotificationRecipient,
  type NotificationResult,
  type NotificationTemplateData,
  type NotificationTemplateKey,
  type PaginatedNotifications,
  type RegisterDeviceTokenDto,
  type SendBulkNotificationDto,
  type SendNotificationDto,
  type UpdatePreferencesDto,
} from './types/notification.types';

/**
 * Optional BullMQ-style queue interface. The Notifications module is
 * deliberately decoupled from BullMQ so tests can inject a stub and
 * the API process can run with no queue at all (forceSync path).
 */
export interface INotificationQueue {
  add(
    name: string,
    data: { notificationId: string; attempt?: number },
    opts?: { delay?: number; attempts?: number; backoff?: unknown },
  ): Promise<{ id?: string | number | null }>;
}

const NOTIFICATIONS_RESOURCE = 'notification';

/**
 * BE-24 — Public Notifications service.
 *
 * Owns the orchestration:
 *   - resolves preferences,
 *   - filters channels,
 *   - applies quiet-hours rescheduling,
 *   - persists the notification row,
 *   - dispatches sync (forceSync / no queue) or via BullMQ,
 *   - records per-channel statuses,
 *   - emits an audit-log entry per send,
 *   - exposes the in-app inbox + preferences + device-token APIs.
 *
 * Sub-services and repositories are injected. The queue is optional —
 * binding is via the `NOTIFICATIONS_QUEUE_TOKEN` symbol so the
 * `JobsModule` (BullMQ owner) can wire it without forcing the dep
 * on the unit-test surface.
 */
@Injectable()
export class NotificationsService implements INotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly repo: NotificationsRepository,
    private readonly preferences: PreferenceManagerService,
    private readonly router: NotificationRouterService,
    private readonly templates: TemplateRendererService,
    private readonly deviceTokens: DeviceTokensRepository,
    private readonly appLogger: LoggerService,
    private readonly auditLog: AuditLogService,
    @Optional()
    @Inject(NOTIFICATIONS_QUEUE_TOKEN)
    private readonly queue?: INotificationQueue,
  ) {}

  /* ───────────────────── send ───────────────────── */

  async send(dto: SendNotificationDto): Promise<NotificationResult> {
    const prefs = await this.preferences.getPreferences(dto.userId);
    const allowed = this.preferences.filterChannels(prefs, dto.channels, dto.category);

    if (allowed.length === 0) {
      this.appLogger.info('notification.blocked.preferences', {
        userId: dto.userId,
        category: dto.category,
        requested: dto.channels,
      });
      // We still create a row (status=skipped per channel) for audit
      // visibility — opted-out users want to see the suppression in
      // the App Owner Dashboard.
      const skipped = await this.repo.create({
        tenantId: dto.tenantId,
        userId: dto.userId,
        category: dto.category,
        template: dto.template,
        subject: dto.subject,
        body: dto.body,
        bodyHtml: dto.bodyHtml,
        priority: dto.priority ?? 'normal',
        channels: dto.channels,
        emailStatus: dto.channels.includes('email') ? 'skipped' : null,
        smsStatus: dto.channels.includes('sms') ? 'skipped' : null,
        pushStatus: dto.channels.includes('push') ? 'skipped' : null,
        inAppStatus: dto.channels.includes('in-app') ? 'skipped' : null,
        relatedResourceType: dto.relatedResourceType,
        relatedResourceId: dto.relatedResourceId,
        data: dto.data,
      });
      return {
        notificationId: skipped.id,
        status: 'skipped',
        channels: dto.channels.map((c) => ({
          channel: c,
          delivered: false,
          error: 'blocked by preferences',
        })),
      };
    }

    // Quiet-hours reschedule (non-urgent).
    let scheduledFor: Date | undefined = dto.scheduledFor ?? undefined;
    const priority = dto.priority ?? 'normal';
    if (!scheduledFor && this.preferences.isQuietHours(prefs, priority)) {
      const next = this.preferences.nextActiveTime(prefs);
      if (next) scheduledFor = next;
    }

    const row = await this.repo.create({
      tenantId: dto.tenantId,
      userId: dto.userId,
      category: dto.category,
      template: dto.template,
      subject: dto.subject,
      body: dto.body,
      bodyHtml: dto.bodyHtml,
      priority,
      channels: allowed,
      emailStatus: allowed.includes('email') ? 'queued' : null,
      smsStatus: allowed.includes('sms') ? 'queued' : null,
      pushStatus: allowed.includes('push') ? 'queued' : null,
      inAppStatus: allowed.includes('in-app') ? 'queued' : null,
      scheduledFor,
      relatedResourceType: dto.relatedResourceType,
      relatedResourceId: dto.relatedResourceId,
      data: dto.data,
    });

    void this.auditLog.logAction({
      action: 'CREATE',
      resourceType: NOTIFICATIONS_RESOURCE,
      resourceId: row.id,
      tenantId: dto.tenantId,
      userId: dto.userId,
      success: true,
      metadata: {
        category: dto.category,
        channels: allowed,
        scheduledFor: scheduledFor?.toISOString(),
        template: dto.template,
      },
    });

    // Schedule via queue if delayed and queue is wired.
    if (scheduledFor && scheduledFor.getTime() > Date.now() && !dto.forceSync) {
      const delay = scheduledFor.getTime() - Date.now();
      if (this.queue) {
        await this.queue.add(
          'send-notification',
          { notificationId: row.id },
          {
            delay,
            attempts: 5,
            backoff: { type: 'exponential', delay: 5_000 },
          },
        );
        return {
          notificationId: row.id,
          status: 'queued',
          channels: allowed.map((c) => ({ channel: c, delivered: false })),
        };
      }
      // No queue available — the row will be picked up by the
      // scheduler cron's "due" sweep.
      this.logger.warn('notification.queue.absent', {
        notificationId: row.id,
        scheduledFor: scheduledFor.toISOString(),
      });
      return {
        notificationId: row.id,
        status: 'queued',
        channels: allowed.map((c) => ({ channel: c, delivered: false })),
      };
    }

    // Dispatch via queue (immediate) when wired and not forced sync.
    if (this.queue && !dto.forceSync) {
      await this.queue.add(
        'send-notification',
        { notificationId: row.id },
        {
          attempts: 5,
          backoff: { type: 'exponential', delay: 5_000 },
        },
      );
      return {
        notificationId: row.id,
        status: 'queued',
        channels: allowed.map((c) => ({ channel: c, delivered: false })),
      };
    }

    // Synchronous fallback — used by tests, by the worker itself, and
    // when running the API process without a Redis/BullMQ wiring.
    return this.dispatchNow(row.id);
  }

  /**
   * Worker-facing entrypoint: read the row, fan out, persist statuses.
   */
  async dispatchNow(notificationId: string): Promise<NotificationResult> {
    const row = await this.repo.findById(notificationId);
    if (!row) {
      throw new DomainNotFoundException(NOTIFICATIONS_RESOURCE, notificationId);
    }

    const channels = (row.channels ?? []) as NotificationChannel[];
    await this.repo.incrementAttempts(notificationId);

    let channelResults: ChannelDeliveryResult[];
    try {
      channelResults = await this.router.sendToChannels(row, channels);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      this.logger.error('notification.dispatch.failed', { notificationId, message });
      await this.repo.update(notificationId, {
        failedAt: new Date(),
        error: message,
      });
      return {
        notificationId,
        status: 'failed',
        channels: channels.map((c) => ({
          channel: c,
          delivered: false,
          error: message,
        })),
      };
    }

    const updates: Record<string, unknown> = {
      sentAt: new Date(),
    };
    let anyDelivered = false;
    for (const r of channelResults) {
      if (r.delivered) anyDelivered = true;
      switch (r.channel) {
        case 'email':
          updates.emailStatus = r.delivered ? 'sent' : 'failed';
          break;
        case 'sms':
          updates.smsStatus = r.delivered ? 'sent' : 'failed';
          break;
        case 'push':
          updates.pushStatus = r.delivered ? 'sent' : 'failed';
          break;
        case 'in-app':
          updates.inAppStatus = r.delivered ? 'delivered' : 'failed';
          break;
      }
    }
    if (!anyDelivered) {
      updates.failedAt = new Date();
      updates.error = channelResults.find((r) => r.error)?.error ?? 'all channels failed';
    }
    await this.repo.update(notificationId, updates);

    return {
      notificationId,
      status: anyDelivered ? 'sent' : 'failed',
      channels: channelResults,
    };
  }

  /* ───────────────────── bulk + template ───────────────────── */

  async sendBulk(dto: SendBulkNotificationDto): Promise<BulkNotificationResult> {
    const results = await Promise.allSettled(
      dto.userIds.map((userId) =>
        this.send({
          tenantId: dto.tenantId,
          userId,
          channels: dto.channels,
          category: dto.category,
          subject: dto.subject,
          body: dto.body,
          bodyHtml: dto.bodyHtml,
          data: dto.data,
          priority: dto.priority,
          template: dto.template,
          relatedResourceType: dto.relatedResourceType,
          relatedResourceId: dto.relatedResourceId,
        }),
      ),
    );

    let successful = 0;
    let failed = 0;
    const errors: Array<{ userId: string; error: string }> = [];

    results.forEach((r, idx) => {
      if (r.status === 'fulfilled' && r.value.status !== 'failed' && r.value.status !== 'skipped') {
        successful += 1;
      } else {
        failed += 1;
        errors.push({
          userId: dto.userIds[idx],
          error:
            r.status === 'rejected'
              ? r.reason instanceof Error
                ? r.reason.message
                : 'unknown'
              : ((r.value as NotificationResult).channels.find((c) => c.error)?.error ??
                'send failed'),
        });
      }
    });

    return {
      totalRecipients: results.length,
      successful,
      failed,
      errors,
    };
  }

  async sendTemplate<K extends NotificationTemplateKey>(
    template: K,
    recipients: NotificationRecipient[],
    data: NotificationTemplateData[K],
    opts: { tenantId: string; channels?: NotificationChannel[] },
  ): Promise<NotificationResult[]> {
    const rendered = await this.templates.render(template, data, {
      tenantId: opts.tenantId,
    });
    const channels =
      opts.channels ?? (this.templates.defaultChannelsFor(template) as NotificationChannel[]);
    const category = (DEFAULT_TEMPLATES[template]?.category ?? 'system') as NotificationCategory;

    const results: NotificationResult[] = [];
    for (const recipient of recipients) {
      const result = await this.send({
        tenantId: opts.tenantId,
        userId: recipient.userId,
        channels,
        category,
        subject: rendered.subject,
        body: rendered.body,
        bodyHtml: rendered.html,
        data: { template, ...(data as Record<string, unknown>) },
        template,
      });
      results.push(result);
    }
    return results;
  }

  /* ───────────────────── preferences ───────────────────── */

  async getPreferences(userId: string): Promise<NotificationPreferences> {
    return this.preferences.getPreferences(userId);
  }

  async updatePreferences(
    userId: string,
    dto: UpdatePreferencesDto & { tenantId?: string | null },
  ): Promise<NotificationPreferences> {
    const result = await this.preferences.updatePreferences(userId, dto.tenantId ?? null, dto);
    void this.auditLog.logAction({
      action: 'UPDATE',
      resourceType: 'notification_preferences',
      resourceId: userId,
      tenantId: dto.tenantId ?? 'system',
      userId,
      success: true,
      metadata: { fields: Object.keys(dto) },
    });
    return result;
  }

  /* ───────────────────── inbox ───────────────────── */

  async getHistory(
    userId: string,
    tenantId: string,
    filters: HistoryFilters,
  ): Promise<PaginatedNotifications> {
    const limit = filters.limit ?? 50;
    let cursor: { createdAt: Date; id: string } | undefined;
    if (filters.cursor) {
      const decoded = decodeCursor(filters.cursor);
      if (decoded && typeof decoded.createdAt === 'string' && typeof decoded.id === 'string') {
        cursor = {
          createdAt: new Date(decoded.createdAt),
          id: decoded.id,
        };
      }
    }

    const rows = await this.repo.listForUser(userId, tenantId, {
      limit,
      cursor,
      category: filters.category,
      unreadOnly: filters.unreadOnly,
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, -1) : rows;
    const nextCursor =
      hasMore && data.length > 0
        ? encodeCursor(
            {
              createdAt: (data[data.length - 1] as NotificationRow).createdAt,
              id: (data[data.length - 1] as NotificationRow).id,
            },
            [
              { field: 'createdAt', direction: 'desc' },
              { field: 'id', direction: 'desc' },
            ],
          )
        : null;

    return {
      data: data.map((row) => ({
        id: row.id,
        category: row.category as NotificationCategory,
        subject: row.subject,
        body: row.body,
        isRead: row.isRead,
        createdAt: row.createdAt,
        sentAt: row.sentAt,
        data: (row.data as Record<string, unknown> | null) ?? null,
        relatedResourceType: row.relatedResourceType,
        relatedResourceId: row.relatedResourceId,
      })),
      nextCursor,
      hasMore,
    };
  }

  async markAsRead(notificationId: string, userId: string): Promise<void> {
    const ok = await this.repo.markRead(notificationId, userId, new Date());
    if (!ok) {
      this.appLogger.info('notification.mark-read.no-op', {
        notificationId,
        userId,
      });
    }
  }

  async markAllAsRead(userId: string): Promise<{ updated: number }> {
    const updated = await this.repo.markAllRead(userId, new Date());
    return { updated };
  }

  /* ───────────────────── device tokens ───────────────────── */

  async registerDeviceToken(
    userId: string,
    tenantId: string | null,
    dto: RegisterDeviceTokenDto,
  ): Promise<{ id: string }> {
    const row = await this.deviceTokens.upsertByToken(
      userId,
      tenantId,
      dto.token,
      dto.platform,
      dto.deviceId,
      dto.appVersion,
    );
    void this.auditLog.logAction({
      action: 'CREATE',
      resourceType: 'device_token',
      resourceId: row.id,
      tenantId: tenantId ?? 'system',
      userId,
      success: true,
      metadata: { platform: dto.platform },
    });
    return { id: row.id };
  }

  async unregisterDeviceToken(userId: string, token: string): Promise<void> {
    await this.deviceTokens.deactivateByUserAndToken(userId, token);
    void this.auditLog.logAction({
      action: 'DELETE',
      resourceType: 'device_token',
      resourceId: token.slice(0, 8),
      tenantId: 'system',
      userId,
      success: true,
    });
  }

  /* ───────────────────── scheduler hooks ───────────────────── */

  /**
   * BE-24 scheduler entry — pull due scheduled notifications and
   * enqueue them. Used both by the scheduler cron and as a recovery
   * path when the queue was offline at the time of the original
   * `send()` call.
   */
  async dispatchDue(now: Date = new Date()): Promise<{
    scanned: number;
    queued: number;
    dispatchedSync: number;
  }> {
    const due = await this.repo.findDueScheduled(now, 200);
    let queued = 0;
    let dispatchedSync = 0;

    for (const row of due) {
      if (this.queue) {
        await this.queue.add(
          'send-notification',
          { notificationId: row.id },
          {
            attempts: 5,
            backoff: { type: 'exponential', delay: 5_000 },
          },
        );
        queued += 1;
      } else {
        await this.dispatchNow(row.id).catch((err: unknown) => {
          this.logger.error('notification.dispatch-due.failed', {
            id: row.id,
            message: err instanceof Error ? err.message : 'unknown',
          });
        });
        dispatchedSync += 1;
      }
    }

    return { scanned: due.length, queued, dispatchedSync };
  }
}
