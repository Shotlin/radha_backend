import { Injectable, Logger } from '@nestjs/common';

import type { NotificationRow } from '@/db/schema/notifications';
import { EmailService } from '@/integrations/email/email.service';
import { LoggerService } from '@/logging/logger.service';

import type { ChannelDeliveryResult } from '../types/notification.types';

interface UserContact {
  email?: string | null;
}

/**
 * BE-24 — Email delivery channel.
 *
 * Wraps `EmailService` (BE-07) and adapts its result shape to
 * `ChannelDeliveryResult`. The notification row already carries the
 * subject + html, so this service is a thin adapter — no template
 * lookups happen here.
 */
@Injectable()
export class EmailNotificationService {
  private readonly logger = new Logger(EmailNotificationService.name);

  constructor(
    private readonly email: EmailService,
    private readonly appLogger: LoggerService,
  ) {}

  async deliver(
    notification: NotificationRow,
    contact: UserContact,
  ): Promise<ChannelDeliveryResult> {
    if (!contact.email) {
      return {
        channel: 'email',
        delivered: false,
        error: 'no email on file',
      };
    }

    const html = notification.bodyHtml ?? `<p>${this.escape(notification.body)}</p>`;

    try {
      const result = await this.email.send({
        to: contact.email,
        subject: notification.subject,
        html,
        text: notification.body,
      });
      if (result.success) {
        this.appLogger.info('notification.email.sent', {
          notificationId: notification.id,
          provider: result.provider,
        });
        return {
          channel: 'email',
          delivered: true,
          messageId: result.messageId,
          providerMeta: { provider: result.provider },
        };
      }
      return {
        channel: 'email',
        delivered: false,
        error: result.error ?? 'email send failed',
        providerMeta: { provider: result.provider },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      this.logger.error('notification.email.failed', { msg });
      return { channel: 'email', delivered: false, error: msg };
    }
  }

  private escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
