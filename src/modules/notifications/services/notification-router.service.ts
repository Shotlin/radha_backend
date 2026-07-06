import { Injectable, Logger } from '@nestjs/common';

import type { NotificationRow } from '@/db/schema/notifications';
import { LoggerService } from '@/logging/logger.service';
import { UsersRepository } from '@/modules/auth/repositories/users.repository';

import type { ChannelDeliveryResult, NotificationChannel } from '../types/notification.types';

import { EmailNotificationService } from './email-notification.service';
import { PushNotificationService } from './push-notification.service';
import { SmsNotificationService } from './sms-notification.service';

interface UserContact {
  email?: string | null;
  mobile?: string | null;
}

/**
 * BE-24 — Channel router.
 *
 * Owns the fan-out from a stored notification row to its requested
 * channels. The router:
 *   - resolves the user's contact details once,
 *   - dispatches each channel concurrently (push + email + in-app run
 *     in parallel — they don't share state),
 *   - never throws: failed channels surface as `delivered=false` so
 *     the caller can record per-channel statuses on the row.
 *
 * The `in-app` channel is a no-op here — the notification row IS the
 * in-app payload. The router still returns a `delivered=true` result
 * for it so the row reflects that the user can read it from their
 * inbox.
 */
@Injectable()
export class NotificationRouterService {
  private readonly logger = new Logger(NotificationRouterService.name);

  constructor(
    private readonly emailChannel: EmailNotificationService,
    private readonly smsChannel: SmsNotificationService,
    private readonly pushChannel: PushNotificationService,
    private readonly users: UsersRepository,
    private readonly appLogger: LoggerService,
  ) {}

  async sendToChannels(
    notification: NotificationRow,
    channels: NotificationChannel[],
  ): Promise<ChannelDeliveryResult[]> {
    if (channels.length === 0) return [];

    const contact = await this.resolveContact(notification.userId).catch((err: unknown) => {
      this.logger.warn('notification.router.contact-lookup.failed', {
        userId: notification.userId,
        message: err instanceof Error ? err.message : 'unknown',
      });
      return {} as UserContact;
    });

    this.appLogger.info('notification.router.dispatching', {
      notificationId: notification.id,
      channels,
    });

    const tasks: Array<Promise<ChannelDeliveryResult>> = channels.map((channel) =>
      this.dispatchChannel(notification, channel, contact),
    );

    const results = await Promise.allSettled(tasks);
    return results.map((r, idx): ChannelDeliveryResult => {
      if (r.status === 'fulfilled') return r.value;
      return {
        channel: channels[idx],
        delivered: false,
        error: r.reason instanceof Error ? r.reason.message : 'channel error',
      };
    });
  }

  private dispatchChannel(
    notification: NotificationRow,
    channel: NotificationChannel,
    contact: UserContact,
  ): Promise<ChannelDeliveryResult> {
    switch (channel) {
      case 'email':
        return this.emailChannel.deliver(notification, contact);
      case 'sms':
        return this.smsChannel.deliver(notification, contact);
      case 'push':
        return this.pushChannel.deliver(notification);
      case 'in-app':
        return Promise.resolve({ channel: 'in-app', delivered: true });
      default:
        return Promise.resolve({
          channel,
          delivered: false,
          error: 'unknown channel',
        });
    }
  }

  private async resolveContact(userId: string): Promise<UserContact> {
    const user = (await this.users.findById(userId)) as {
      email?: string | null;
      mobile?: string | null;
    } | null;
    if (!user) return {};
    return {
      email: user.email ?? null,
      mobile: user.mobile ?? null,
    };
  }
}
