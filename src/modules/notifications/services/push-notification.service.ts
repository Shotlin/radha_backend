import { Injectable, Logger } from '@nestjs/common';

import type { NotificationRow } from '@/db/schema/notifications';
import { FcmService } from '@/integrations/fcm/fcm.service';
import { LoggerService } from '@/logging/logger.service';

import { DeviceTokensRepository } from '../repositories/device-tokens.repository';
import type { ChannelDeliveryResult, NotificationPriority } from '../types/notification.types';

/**
 * BE-24 — Push delivery channel (FCM).
 *
 * Pulls the user's active device tokens, fans out the multicast,
 * marks any permanent-failure tokens inactive on the way back.
 *
 * Per-token results aren't surfaced individually on the
 * `ChannelDeliveryResult` — they're collapsed to a single
 * delivered=true if at least one token succeeded. The processor
 * still gets the per-token data through `providerMeta` for
 * downstream metrics.
 */
@Injectable()
export class PushNotificationService {
  private readonly logger = new Logger(PushNotificationService.name);

  constructor(
    private readonly fcm: FcmService,
    private readonly deviceTokens: DeviceTokensRepository,
    private readonly appLogger: LoggerService,
  ) {}

  async deliver(notification: NotificationRow): Promise<ChannelDeliveryResult> {
    const tokens = await this.deviceTokens.findActiveForUser(notification.userId);
    if (tokens.length === 0) {
      return {
        channel: 'push',
        delivered: false,
        error: 'no active device tokens',
      };
    }

    const tokenStrings = tokens.map((t) => t.token);
    const priority: NotificationPriority =
      (notification.priority as NotificationPriority | null) ?? 'normal';

    const result = await this.fcm.send({
      tokens: tokenStrings,
      title:
        this.firstLine(notification.subject) || this.firstLine(notification.body) || 'Notification',
      body: this.firstLine(notification.body) || notification.subject,
      priority: priority === 'urgent' || priority === 'high' ? 'high' : 'normal',
      data: {
        notificationId: notification.id,
        category: notification.category,
        ...(notification.relatedResourceType
          ? { resourceType: notification.relatedResourceType }
          : {}),
        ...(notification.relatedResourceId ? { resourceId: notification.relatedResourceId } : {}),
      },
    });

    // Permanent-failure tokens get marked invalid so the next send
    // path skips them.
    const invalidTokens = result.perToken.filter((r) => r.permanentFailure).map((r) => r.token);
    if (invalidTokens.length > 0) {
      const reason = result.perToken.find((r) => r.permanentFailure)?.reason ?? 'unknown';
      await this.deviceTokens.markInvalidByTokens(invalidTokens, reason).catch((err: unknown) => {
        this.logger.warn('notification.push.token-cleanup.failed', {
          message: err instanceof Error ? err.message : 'unknown',
        });
      });
    }

    if (result.successCount > 0) {
      this.appLogger.info('notification.push.sent', {
        notificationId: notification.id,
        succeeded: result.successCount,
        failed: result.failureCount,
      });
      return {
        channel: 'push',
        delivered: true,
        messageId: result.perToken.find((r) => r.success)?.messageId,
        providerMeta: {
          successCount: result.successCount,
          failureCount: result.failureCount,
          totalTokens: tokens.length,
        },
      };
    }

    return {
      channel: 'push',
      delivered: false,
      error: result.globalError ?? 'all tokens failed',
      providerMeta: {
        successCount: 0,
        failureCount: result.failureCount,
        totalTokens: tokens.length,
      },
    };
  }

  private firstLine(s: string): string {
    return s.split('\n', 1)[0]?.trim() ?? '';
  }
}
