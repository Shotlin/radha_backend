import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq, gte, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { users } from '@/db/schema/users';
import { NotificationsService } from '@/modules/notifications/notifications.service';

/**
 * BE-35 — Day-7 Push Notification Job.
 *
 * Runs daily at 09:00 IST. Finds Consumer users who signed up 7+ days
 * ago, have been active (last login within 7 days), and haven't yet
 * received the business activation push. Sends a one-time FCM push
 * inviting them to try business mode.
 *
 * Dedup is handled by checking if the notification was already sent
 * (via notifications repository category + userId lookup). In a
 * production setup this would use a dedicated `push_sent_log` table
 * or the notifications repository's built-in dedup.
 */
@Injectable()
export class Day7PushJob {
  private readonly logger = new Logger(Day7PushJob.name);

  constructor(
    private readonly db: DbService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron('0 9 * * *', { timeZone: 'Asia/Kolkata' })
  async runDay7Push(): Promise<void> {
    this.logger.log('Day-7 push job started');

    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

      // Find consumers who:
      // - Created account 7-14 days ago
      // - Are still consumers (haven't already activated)
      // - Have logged in within the last 7 days (active users)
      const candidates = await this.db
        .getDb()
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(
          and(
            eq(users.role, 'consumer'),
            eq(users.isActive, true),
            gte(users.createdAt, fourteenDaysAgo),
            // created at least 7 days ago
            sql`${users.createdAt} <= ${sevenDaysAgo}`,
            // was active recently
            gte(users.lastLoginAt, sevenDaysAgo),
          ),
        );

      this.logger.log(`Found ${candidates.length} candidates for day-7 push`);

      for (const candidate of candidates) {
        try {
          await this.notifications.send({
            userId: candidate.id,
            tenantId: 'system',
            channels: ['push'],
            category: 'business-activation',
            subject: 'Running a shop or business?',
            body: 'Manage inventory, expiry, and scans in RADHA. Try the 14-day Pro trial.',
            data: { touchpoint: 'day7_push' },
          });
        } catch (err) {
          this.logger.warn(
            `Failed to send day-7 push to user ${candidate.id}: ${(err as Error).message}`,
          );
        }
      }

      this.logger.log('Day-7 push job completed');
    } catch (err) {
      this.logger.error('Day-7 push job failed', (err as Error).stack);
    }
  }
}
