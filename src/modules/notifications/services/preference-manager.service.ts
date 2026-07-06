import { Injectable } from '@nestjs/common';

import { NotificationPreferencesRepository } from '../repositories/notification-preferences.repository';
import type {
  NotificationCategory,
  NotificationChannel,
  NotificationPreferences,
  NotificationPriority,
  UpdatePreferencesDto,
} from '../types/notification.types';

/**
 * BE-24 — Preference manager.
 *
 * Owns:
 *   - default-on-first-read seeding,
 *   - channel filtering against per-user toggles + per-category opts,
 *   - quiet-hours arithmetic (overnight-aware),
 *   - "is the user gone radio-silent on this category" predicate.
 *
 * Stores `category` opt-ins as a JSONB map (default-enabled when key
 * absent) so adding a new category is a config change, not a data
 * migration.
 *
 * SMS is locked to the `auth` category (Req 28: SMS = OTP only).
 * The router enforces this before consulting per-user prefs.
 */

const DEFAULT_PREFS: Omit<NotificationPreferences, 'userId'> = {
  channels: { email: true, sms: true, push: true, inApp: true },
  categories: {
    auth: true,
    'expiry-alert': true,
    task: true,
    report: true,
    system: true,
    marketing: false, // Marketing is opt-in by default (GDPR-friendly).
    'recall-alert': true,
    'daily-insights': true,
    'business-activation': true,
  },
  digestFrequency: 'realtime',
};

@Injectable()
export class PreferenceManagerService {
  constructor(private readonly repo: NotificationPreferencesRepository) {}

  async getPreferences(userId: string): Promise<NotificationPreferences> {
    const row = await this.repo.findByUser(userId);
    if (!row) return { userId, ...DEFAULT_PREFS };

    const optIns = row.categoryOptIns ?? {};
    const categories: NotificationPreferences['categories'] = {
      ...DEFAULT_PREFS.categories,
    };
    for (const [k, v] of Object.entries(optIns)) {
      categories[k as NotificationCategory] = Boolean(v);
    }

    const result: NotificationPreferences = {
      userId,
      channels: {
        email: row.emailEnabled,
        sms: row.smsEnabled,
        push: row.pushEnabled,
        inApp: row.inAppEnabled,
      },
      categories,
      digestFrequency:
        (row.digestFrequency as NotificationPreferences['digestFrequency']) ?? 'realtime',
    };

    if (row.quietHoursEnabled && row.quietHoursStart && row.quietHoursEnd) {
      result.quietHours = {
        enabled: true,
        start: row.quietHoursStart,
        end: row.quietHoursEnd,
        timezone: row.timezone,
      };
    }

    return result;
  }

  async updatePreferences(
    userId: string,
    tenantId: string | null,
    dto: UpdatePreferencesDto,
  ): Promise<NotificationPreferences> {
    const current = await this.getPreferences(userId);

    const merged: NotificationPreferences = {
      ...current,
      channels: { ...current.channels, ...(dto.channels ?? {}) },
      categories: { ...current.categories, ...(dto.categories ?? {}) },
      digestFrequency: dto.digestFrequency ?? current.digestFrequency,
      quietHours: dto.quietHours ?? current.quietHours,
    };

    await this.repo.upsertForUser(userId, tenantId, {
      emailEnabled: merged.channels.email,
      smsEnabled: merged.channels.sms,
      pushEnabled: merged.channels.push,
      inAppEnabled: merged.channels.inApp,
      categoryOptIns: merged.categories as Record<string, boolean>,
      quietHoursEnabled: merged.quietHours?.enabled ?? false,
      quietHoursStart: merged.quietHours?.start ?? null,
      quietHoursEnd: merged.quietHours?.end ?? null,
      timezone: merged.quietHours?.timezone ?? 'Asia/Kolkata',
      digestFrequency: merged.digestFrequency,
    });

    return merged;
  }

  /**
   * Filter the requested channels by what the user actually allows
   * for this category. Returns the surviving subset (possibly empty).
   *
   * SMS is *only* allowed for `auth` (OTP delivery), regardless of
   * preferences.
   */
  filterChannels(
    prefs: NotificationPreferences,
    requested: NotificationChannel[],
    category: NotificationCategory,
  ): NotificationChannel[] {
    const categoryAllowed = prefs.categories[category] !== false;
    if (!categoryAllowed) return [];

    return requested.filter((channel) => {
      if (channel === 'sms' && category !== 'auth') return false;
      const map: Record<NotificationChannel, boolean> = {
        email: prefs.channels.email,
        sms: prefs.channels.sms,
        push: prefs.channels.push,
        'in-app': prefs.channels.inApp,
      };
      return map[channel];
    });
  }

  /**
   * Quiet-hours predicate. Honoured for everything except `urgent`
   * priority sends.
   *
   * Timezone handling reads the user's local hour/minute via
   * `Intl.DateTimeFormat`, so no external `tz` dep is needed.
   */
  isQuietHours(
    prefs: NotificationPreferences,
    priority: NotificationPriority,
    now: Date = new Date(),
  ): boolean {
    if (priority === 'urgent') return false;
    const qh = prefs.quietHours;
    if (!qh?.enabled) return false;

    const localHM = this.toLocalHM(now, qh.timezone);
    const startMin = this.parseHM(qh.start);
    const endMin = this.parseHM(qh.end);
    if (startMin === null || endMin === null) return false;

    const nowMin = localHM.h * 60 + localHM.m;
    if (startMin <= endMin) {
      return nowMin >= startMin && nowMin < endMin;
    }
    // Overnight (e.g. 22:00 → 07:00).
    return nowMin >= startMin || nowMin < endMin;
  }

  /**
   * Compute the next moment a non-urgent send would not be in quiet
   * hours. Returns `null` when quiet hours are off.
   *
   * Implementation: walk forward in 5-minute increments from `now`
   * until quiet hours stop. Bounded at 25 hours so we never loop
   * (worst case: a 24h quiet window misconfigured).
   */
  nextActiveTime(prefs: NotificationPreferences, now: Date = new Date()): Date | null {
    const qh = prefs.quietHours;
    if (!qh?.enabled) return null;

    const stepMs = 5 * 60 * 1000;
    const limit = 25 * 60; // minutes
    for (let i = 1; i <= limit / 5; i += 1) {
      const candidate = new Date(now.getTime() + i * stepMs);
      if (!this.isQuietHours(prefs, 'normal', candidate)) {
        return candidate;
      }
    }
    return null;
  }

  /* ───────────────────── Internal ───────────────────── */

  private parseHM(hm: string): number | null {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hm);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  private toLocalHM(date: Date, timezone: string): { h: number; m: number } {
    try {
      const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const parts = fmt.formatToParts(date);
      const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
      const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
      return { h, m };
    } catch {
      return { h: date.getUTCHours(), m: date.getUTCMinutes() };
    }
  }
}
