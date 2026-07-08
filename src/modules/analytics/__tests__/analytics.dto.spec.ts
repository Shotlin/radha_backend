import { CreateLeadSchema } from '../dto/create-lead.dto';
import { ListLeadsQuerySchema } from '../dto/list-leads.dto';
import { TrackAppEventBatchSchema, TrackAppEventSchema } from '../dto/track-app-event.dto';
import { TrackWebsiteEventSchema } from '../dto/track-website-event.dto';
import { ConvertLeadSchema, UpdateLeadSchema } from '../dto/update-lead.dto';
import { WebsiteStatsQuerySchema } from '../dto/website-stats-query.dto';

describe('TrackWebsiteEventSchema', () => {
  it('accepts a minimal page_view payload', () => {
    expect(() =>
      TrackWebsiteEventSchema.parse({ type: 'page_view', sessionId: 's' }),
    ).not.toThrow();
  });

  it('rejects unknown fields (forbidNonWhitelisted)', () => {
    expect(() =>
      TrackWebsiteEventSchema.parse({
        type: 'page_view',
        sessionId: 's',
        ipAddress: '1.2.3.4',
      }),
    ).toThrow();
  });

  it('rejects bad event type', () => {
    expect(() => TrackWebsiteEventSchema.parse({ type: 'pwn_view', sessionId: 's' })).toThrow();
  });

  it('uppercases the country code', () => {
    const out = TrackWebsiteEventSchema.parse({
      type: 'page_view',
      sessionId: 's',
      country: 'in',
    });
    expect(out.country).toBe('IN');
  });

  it('rejects invalid country', () => {
    expect(() =>
      TrackWebsiteEventSchema.parse({
        type: 'page_view',
        sessionId: 's',
        country: 'India',
      }),
    ).toThrow();
  });
});

describe('CreateLeadSchema', () => {
  const valid = {
    name: 'Alice',
    email: 'Alice@Example.COM',
    source: 'contact_form' as const,
  };

  it('lowercases the email', () => {
    expect(CreateLeadSchema.parse(valid).email).toBe('alice@example.com');
  });

  it('rejects invalid email', () => {
    expect(() => CreateLeadSchema.parse({ ...valid, email: 'not-an-email' })).toThrow();
  });

  it('rejects unknown fields', () => {
    expect(() => CreateLeadSchema.parse({ ...valid, ipAddress: '1.2.3.4' })).toThrow();
  });

  it('accepts an Indian mobile with country code', () => {
    expect(() => CreateLeadSchema.parse({ ...valid, mobile: '+91 9876543210' })).not.toThrow();
  });

  it('rejects malformed mobile', () => {
    expect(() => CreateLeadSchema.parse({ ...valid, mobile: '12345' })).toThrow();
  });

  it('accepts valid pageUrl, rejects garbage', () => {
    expect(() =>
      CreateLeadSchema.parse({ ...valid, pageUrl: 'https://radha.in/pricing' }),
    ).not.toThrow();
    expect(() => CreateLeadSchema.parse({ ...valid, pageUrl: 'not a url' })).toThrow();
  });
});

describe('ListLeadsQuerySchema', () => {
  it('coerces limit and applies default', () => {
    const out = ListLeadsQuerySchema.parse({});
    expect(out.limit).toBe(50);
  });

  it('rejects limit > 100', () => {
    expect(() => ListLeadsQuerySchema.parse({ limit: 1000 })).toThrow();
  });
});

describe('TrackAppEventSchema', () => {
  it('accepts minimal app event', () => {
    const out = TrackAppEventSchema.parse({
      eventType: 'screen_view',
      category: 'home',
      action: 'view',
    });
    expect(out.eventType).toBe('screen_view');
  });

  it('rejects extra fields', () => {
    expect(() =>
      TrackAppEventSchema.parse({
        eventType: 'screen_view',
        category: 'home',
        action: 'view',
        userId: 'fake-user',
      }),
    ).toThrow();
  });
});

describe('TrackAppEventBatchSchema', () => {
  it('caps batch size at 100', () => {
    const events = Array.from({ length: 101 }, () => ({
      eventType: 'screen_view' as const,
      category: 'home',
      action: 'view',
    }));
    expect(() => TrackAppEventBatchSchema.parse({ events })).toThrow();
  });

  it('requires non-empty array', () => {
    expect(() => TrackAppEventBatchSchema.parse({ events: [] })).toThrow();
  });
});

describe('UpdateLeadSchema + ConvertLeadSchema', () => {
  it('UpdateLeadSchema requires status', () => {
    expect(() => UpdateLeadSchema.parse({})).toThrow();
  });

  it('UpdateLeadSchema rejects unknown statuses', () => {
    expect(() => UpdateLeadSchema.parse({ status: 'done' })).toThrow();
  });

  it('ConvertLeadSchema requires uuid tenantId', () => {
    expect(() => ConvertLeadSchema.parse({ tenantId: 'not-uuid' })).toThrow();
    expect(() =>
      ConvertLeadSchema.parse({ tenantId: '11111111-1111-1111-1111-111111111111' }),
    ).not.toThrow();
  });
});

describe('WebsiteStatsQuerySchema', () => {
  it('accepts YYYY-MM-DD dates', () => {
    expect(() =>
      WebsiteStatsQuerySchema.parse({ from: '2026-01-01', to: '2026-01-31' }),
    ).not.toThrow();
  });

  it('rejects when from > to', () => {
    expect(() => WebsiteStatsQuerySchema.parse({ from: '2026-02-01', to: '2026-01-01' })).toThrow();
  });

  it('rejects malformed date', () => {
    expect(() => WebsiteStatsQuerySchema.parse({ from: 'tomorrow', to: 'now' })).toThrow();
  });
});
