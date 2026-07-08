import { PreferenceManagerService } from '../services/preference-manager.service';

const buildRepoStub = (rowOverride: unknown = null) =>
  ({
    findByUser: jest.fn(async () => rowOverride),
    upsertForUser: jest.fn(async (userId: string, _t: unknown, patch: unknown) => ({
      id: 'r1',
      userId,
      ...(patch as object),
    })),
  }) as unknown as ConstructorParameters<typeof PreferenceManagerService>[0];

describe('PreferenceManagerService', () => {
  describe('getPreferences', () => {
    it('returns defaults when no row exists (marketing opt-out)', async () => {
      const svc = new PreferenceManagerService(buildRepoStub(null));
      const prefs = await svc.getPreferences('u1');

      expect(prefs.userId).toBe('u1');
      expect(prefs.channels).toEqual({
        email: true,
        sms: true,
        push: true,
        inApp: true,
      });
      expect(prefs.categories.marketing).toBe(false);
      expect(prefs.categories['expiry-alert']).toBe(true);
      expect(prefs.digestFrequency).toBe('realtime');
      expect(prefs.quietHours).toBeUndefined();
    });

    it('merges category opt-ins from the row JSONB over defaults', async () => {
      const svc = new PreferenceManagerService(
        buildRepoStub({
          emailEnabled: false,
          smsEnabled: true,
          pushEnabled: true,
          inAppEnabled: true,
          categoryOptIns: { marketing: true, 'expiry-alert': false },
          quietHoursEnabled: true,
          quietHoursStart: '22:00',
          quietHoursEnd: '07:00',
          timezone: 'Asia/Kolkata',
          digestFrequency: 'daily',
        }),
      );

      const prefs = await svc.getPreferences('u2');
      expect(prefs.channels.email).toBe(false);
      expect(prefs.categories.marketing).toBe(true);
      expect(prefs.categories['expiry-alert']).toBe(false);
      expect(prefs.quietHours).toEqual({
        enabled: true,
        start: '22:00',
        end: '07:00',
        timezone: 'Asia/Kolkata',
      });
      expect(prefs.digestFrequency).toBe('daily');
    });
  });

  describe('filterChannels', () => {
    const svc = new PreferenceManagerService(buildRepoStub(null));

    it('excludes channels disabled at the user level', async () => {
      const prefs = await svc.getPreferences('u');
      prefs.channels.email = false;

      const allowed = svc.filterChannels(prefs, ['email', 'in-app'], 'task');
      expect(allowed).toEqual(['in-app']);
    });

    it('forces SMS to auth-only', async () => {
      const prefs = await svc.getPreferences('u');
      const allowed = svc.filterChannels(prefs, ['sms', 'in-app'], 'task');
      expect(allowed).toEqual(['in-app']);
    });

    it('returns empty when the category is opted out', async () => {
      const prefs = await svc.getPreferences('u');
      prefs.categories.marketing = false;
      const allowed = svc.filterChannels(prefs, ['email', 'push'], 'marketing');
      expect(allowed).toEqual([]);
    });

    it('allows SMS for the auth category', async () => {
      const prefs = await svc.getPreferences('u');
      const allowed = svc.filterChannels(prefs, ['sms'], 'auth');
      expect(allowed).toEqual(['sms']);
    });
  });

  describe('isQuietHours', () => {
    const svc = new PreferenceManagerService(buildRepoStub(null));

    it('returns false when quiet hours disabled', () => {
      const prefs = {
        userId: 'u',
        channels: { email: true, sms: true, push: true, inApp: true },
        categories: {} as Record<string, boolean>,
        digestFrequency: 'realtime' as const,
      };
      expect(svc.isQuietHours(prefs as never, 'normal', new Date())).toBe(false);
    });

    it('returns true inside an overnight window', () => {
      const prefs = {
        userId: 'u',
        channels: { email: true, sms: true, push: true, inApp: true },
        categories: {} as Record<string, boolean>,
        digestFrequency: 'realtime' as const,
        quietHours: {
          enabled: true,
          start: '22:00',
          end: '07:00',
          timezone: 'UTC',
        },
      };
      const at23utc = new Date('2027-01-10T23:30:00Z');
      expect(svc.isQuietHours(prefs as never, 'normal', at23utc)).toBe(true);

      const at12utc = new Date('2027-01-10T12:00:00Z');
      expect(svc.isQuietHours(prefs as never, 'normal', at12utc)).toBe(false);
    });

    it('urgent priority bypasses quiet hours', () => {
      const prefs = {
        userId: 'u',
        channels: { email: true, sms: true, push: true, inApp: true },
        categories: {} as Record<string, boolean>,
        digestFrequency: 'realtime' as const,
        quietHours: {
          enabled: true,
          start: '00:00',
          end: '23:59',
          timezone: 'UTC',
        },
      };
      const at12utc = new Date('2027-01-10T12:00:00Z');
      expect(svc.isQuietHours(prefs as never, 'urgent', at12utc)).toBe(false);
    });
  });

  describe('updatePreferences', () => {
    it('persists merged values via upsert', async () => {
      const repo = buildRepoStub(null);
      const svc = new PreferenceManagerService(repo);

      const result = await svc.updatePreferences('u1', null, {
        channels: { email: false },
        categories: { marketing: true },
        digestFrequency: 'weekly',
      });

      expect(result.channels.email).toBe(false);
      expect(result.categories.marketing).toBe(true);
      expect(result.digestFrequency).toBe('weekly');

      const upsertCall = (repo as unknown as { upsertForUser: jest.Mock }).upsertForUser.mock
        .calls[0];
      expect(upsertCall[0]).toBe('u1');
      expect(upsertCall[2].emailEnabled).toBe(false);
      expect(upsertCall[2].digestFrequency).toBe('weekly');
    });
  });
});
