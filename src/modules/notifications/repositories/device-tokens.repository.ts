import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { DeviceTokenRow, NewDeviceToken, deviceTokens } from '@/db/schema/notifications';

/**
 * BE-24 — `device_tokens` repository.
 *
 * Owns FCM token lifecycle: register / re-register transfers
 * ownership, mark-invalid flips `is_active=false`, and a list-active
 * lookup feeds the push channel.
 */
@Injectable()
export class DeviceTokensRepository extends BaseRepository<
  typeof deviceTokens,
  DeviceTokenRow,
  NewDeviceToken,
  Partial<NewDeviceToken>
> {
  constructor(db: DbService) {
    super(db.getDb(), deviceTokens, 'device_tokens');
  }

  /**
   * Register or transfer a token.
   *   - If the token doesn't exist: insert.
   *   - If it exists with the same user: bump `last_used_at` + reactivate.
   *   - If it exists with a different user: transfer ownership and
   *     reactivate (the previous user lost access to the device).
   */
  async upsertByToken(
    userId: string,
    tenantId: string | null,
    token: string,
    platform: 'ios' | 'android' | 'web',
    deviceId?: string,
    appVersion?: string,
  ): Promise<DeviceTokenRow> {
    const insertValues: NewDeviceToken = {
      userId,
      tenantId,
      token,
      platform,
      deviceId,
      appVersion,
      isActive: true,
      lastUsedAt: new Date(),
    };

    const [row] = await this.db
      .insert(deviceTokens)
      .values(insertValues)
      .onConflictDoUpdate({
        target: deviceTokens.token,
        set: {
          userId,
          tenantId,
          platform,
          deviceId,
          appVersion,
          isActive: true,
          invalidatedAt: null,
          invalidationReason: null,
          lastUsedAt: sql`now()`,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return row as DeviceTokenRow;
  }

  async findActiveForUser(userId: string): Promise<DeviceTokenRow[]> {
    return (await this.db
      .select()
      .from(deviceTokens)
      .where(
        and(eq(deviceTokens.userId, userId), eq(deviceTokens.isActive, true)),
      )) as DeviceTokenRow[];
  }

  async findActiveForUsers(userIds: string[]): Promise<DeviceTokenRow[]> {
    if (userIds.length === 0) return [];
    return (await this.db
      .select()
      .from(deviceTokens)
      .where(
        and(eq(deviceTokens.isActive, true), inArray(deviceTokens.userId, userIds)),
      )) as DeviceTokenRow[];
  }

  async markInvalidByToken(token: string, reason: string, now: Date = new Date()): Promise<void> {
    await this.db
      .update(deviceTokens)
      .set({
        isActive: false,
        invalidatedAt: now,
        invalidationReason: reason,
        updatedAt: now,
      })
      .where(eq(deviceTokens.token, token));
  }

  async markInvalidByTokens(
    tokens: string[],
    reason: string,
    now: Date = new Date(),
  ): Promise<number> {
    if (tokens.length === 0) return 0;
    const result = await this.db
      .update(deviceTokens)
      .set({
        isActive: false,
        invalidatedAt: now,
        invalidationReason: reason,
        updatedAt: now,
      })
      .where(inArray(deviceTokens.token, tokens))
      .returning({ id: deviceTokens.id });
    return (result as Array<unknown>).length;
  }

  async deactivateByUserAndToken(userId: string, token: string): Promise<void> {
    await this.db
      .update(deviceTokens)
      .set({
        isActive: false,
        invalidatedAt: new Date(),
        invalidationReason: 'user_logout',
        updatedAt: new Date(),
      })
      .where(and(eq(deviceTokens.userId, userId), eq(deviceTokens.token, token)));
  }
}
