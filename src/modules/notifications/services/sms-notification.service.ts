import { Injectable, Logger } from '@nestjs/common';

import type { NotificationRow } from '@/db/schema/notifications';
import { SmsService } from '@/integrations/sms/sms.service';
import { LoggerService } from '@/logging/logger.service';

import type { ChannelDeliveryResult } from '../types/notification.types';

interface UserContact {
  mobile?: string | null;
}

/**
 * BE-24 — SMS delivery channel.
 *
 * Per Req 28 the SMS channel is reserved for OTP / `auth` category
 * notifications only. The router enforces this; this service simply
 * forwards to `SmsService.sendNotification` and adapts the result.
 *
 * SMS bodies are truncated to 480 chars at the schema layer; the
 * provider further caps at 160-char concatenated segments.
 */
@Injectable()
export class SmsNotificationService {
  private readonly logger = new Logger(SmsNotificationService.name);

  constructor(
    private readonly sms: SmsService,
    private readonly appLogger: LoggerService,
  ) {}

  async deliver(
    notification: NotificationRow,
    contact: UserContact,
  ): Promise<ChannelDeliveryResult> {
    if (!contact.mobile) {
      return { channel: 'sms', delivered: false, error: 'no mobile on file' };
    }

    try {
      const result = await this.sms.sendNotification(contact.mobile, notification.body);
      if (result.success) {
        this.appLogger.info('notification.sms.sent', {
          notificationId: notification.id,
          provider: result.provider,
        });
        return {
          channel: 'sms',
          delivered: true,
          messageId: result.messageId,
          providerMeta: { provider: result.provider },
        };
      }
      return {
        channel: 'sms',
        delivered: false,
        error: result.error ?? 'sms send failed',
        providerMeta: { provider: result.provider },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      this.logger.error('notification.sms.failed', { msg });
      return { channel: 'sms', delivered: false, error: msg };
    }
  }
}
