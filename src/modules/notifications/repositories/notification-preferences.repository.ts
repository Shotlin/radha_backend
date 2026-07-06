import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import {
  NewNotificationPreference,
  NotificationPreferenceRow,
  notificationPreferences,
} from '@/db/schema/notifications';

/**
 * BE-24 — `notification_preferences` table.
 *
 * One row per user. The `upsertForUser` helper uses Postgres
 * `ON CONFLICT (user_id) DO UPDATE` so the preference manager service
 * can blindly write without a read-modify-write race.
 */
@Injectable()
export class NotificationPreferencesRepository extends BaseRepository<
  typeof notificationPreferences,
  NotificationPreferenceRow,
  NewNotificationPreference,
  Partial<NewNotificationPreference>
> {
  constructor(db: DbService) {
    super(db.getDb(), notificationPreferences, 'notification_preferences');
  }

  async findByUser(userId: string): Promise<NotificationPreferenceRow | null> {
    const [row] = await this.db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId))
      .limit(1);
    return (row as NotificationPreferenceRow | undefined) ?? null;
  }

  /**
   * Idempotent UPSERT keyed on `user_id`. Used by the seeder path
   * (first preference read inserts defaults) and the update API.
   */
  async upsertForUser(
    userId: string,
    tenantId: string | null,
    patch: Partial<NewNotificationPreference>,
  ): Promise<NotificationPreferenceRow> {
    const insertValues: NewNotificationPreference = {
      userId,
      tenantId,
      ...patch,
    } as NewNotificationPreference;

    const [row] = await this.db
      .insert(notificationPreferences)
      .values(insertValues)
      .onConflictDoUpdate({
        target: notificationPreferences.userId,
        set: {
          ...patch,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return row as NotificationPreferenceRow;
  }
}
