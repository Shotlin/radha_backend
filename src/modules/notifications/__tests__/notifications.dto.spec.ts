import {
  ListNotificationsQuerySchema,
  RegisterDeviceTokenSchema,
  TestNotificationSchema,
  UnregisterDeviceTokenSchema,
  UpdatePreferencesSchema,
} from '../dto/notifications.dto';

describe('ListNotificationsQuerySchema', () => {
  it('applies defaults for missing fields', () => {
    const parsed = ListNotificationsQuerySchema.parse({});
    expect(parsed.limit).toBe(50);
    expect(parsed.unreadOnly).toBe(false);
  });

  it('coerces limit and rejects out-of-range', () => {
    expect(() => ListNotificationsQuerySchema.parse({ limit: '200' })).toThrow();
    expect(ListNotificationsQuerySchema.parse({ limit: '25' }).limit).toBe(25);
  });
});

describe('UpdatePreferencesSchema', () => {
  it('rejects empty body', () => {
    expect(() => UpdatePreferencesSchema.parse({})).toThrow();
  });

  it('accepts partial channel toggles', () => {
    const parsed = UpdatePreferencesSchema.parse({
      channels: { email: false },
    });
    expect(parsed.channels?.email).toBe(false);
  });

  it('rejects malformed quiet hours', () => {
    expect(() =>
      UpdatePreferencesSchema.parse({
        quietHours: {
          enabled: true,
          start: '24:00',
          end: '07:00',
          timezone: 'UTC',
        },
      }),
    ).toThrow();
  });

  it('accepts well-formed quiet hours', () => {
    const parsed = UpdatePreferencesSchema.parse({
      quietHours: {
        enabled: true,
        start: '22:00',
        end: '07:00',
        timezone: 'Asia/Kolkata',
      },
    });
    expect(parsed.quietHours?.start).toBe('22:00');
  });

  it('rejects unknown digestFrequency', () => {
    expect(() => UpdatePreferencesSchema.parse({ digestFrequency: 'monthly' })).toThrow();
  });
});

describe('TestNotificationSchema', () => {
  it('requires uuid for userId', () => {
    expect(() =>
      TestNotificationSchema.parse({
        userId: 'not-uuid',
        channels: ['in-app'],
        category: 'task',
        subject: 's',
        body: 'b',
      }),
    ).toThrow();
  });

  it('rejects empty channel array', () => {
    expect(() =>
      TestNotificationSchema.parse({
        userId: '00000000-0000-0000-0000-000000000000',
        channels: [],
        category: 'task',
        subject: 's',
        body: 'b',
      }),
    ).toThrow();
  });
});

describe('RegisterDeviceTokenSchema', () => {
  it('requires a non-trivial token', () => {
    expect(() =>
      RegisterDeviceTokenSchema.parse({
        token: 'short',
        platform: 'android',
      }),
    ).toThrow();
  });

  it('accepts a valid token + platform', () => {
    const parsed = RegisterDeviceTokenSchema.parse({
      token: 'a'.repeat(120),
      platform: 'ios',
    });
    expect(parsed.platform).toBe('ios');
  });

  it('rejects unknown platform', () => {
    expect(() =>
      RegisterDeviceTokenSchema.parse({
        token: 'a'.repeat(120),
        platform: 'desktop',
      }),
    ).toThrow();
  });
});

describe('UnregisterDeviceTokenSchema', () => {
  it('requires a token of reasonable length', () => {
    expect(() => UnregisterDeviceTokenSchema.parse({ token: 'abc' })).toThrow();
    expect(UnregisterDeviceTokenSchema.parse({ token: 'a'.repeat(50) }).token).toHaveLength(50);
  });
});
