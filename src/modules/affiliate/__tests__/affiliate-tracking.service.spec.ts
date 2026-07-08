import { createHmac } from 'node:crypto';

import { BadRequestException, UnauthorizedException } from '@nestjs/common';

import type {
  AffiliateClickRow,
  AffiliatePartnerRow,
  AffiliateRevenueRow,
} from '@/db/schema/affiliate';

import type { AffiliateClickRepository } from '../repositories/affiliate-click.repository';
import type { AffiliatePartnerRepository } from '../repositories/affiliate-partner.repository';
import type { AffiliateRevenueRepository } from '../repositories/affiliate-revenue.repository';
import { AffiliateTrackingService } from '../services/affiliate-tracking.service';

/**
 * BE-41 — `AffiliateTrackingService` unit tests.
 *
 * Covers click logging, revenue ingestion, click-attribution
 * validation, aggregate sums, and HMAC signature verification.
 */

const partnerRow = (overrides: Partial<AffiliatePartnerRow> = {}): AffiliatePartnerRow =>
  ({
    id: 'p-amazon',
    name: 'amazon',
    affiliateId: 'radha-21',
    linkTemplate: 'https://x.test/{ean}?tag={affiliateId}',
    hmacSecret: 'topsecret',
    isActive: true,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  }) as AffiliatePartnerRow;

const clickRow = (overrides: Partial<AffiliateClickRow> = {}): AffiliateClickRow =>
  ({
    id: 'c-1',
    userId: 'u-1',
    sourceProductEan: 'src',
    alternativeProductEan: 'alt',
    partnerId: 'p-amazon',
    clickedAt: new Date('2025-02-01T00:00:00Z'),
    createdAt: new Date('2025-02-01T00:00:00Z'),
    updatedAt: new Date('2025-02-01T00:00:00Z'),
    ...overrides,
  }) as AffiliateClickRow;

const revenueRow = (overrides: Partial<AffiliateRevenueRow> = {}): AffiliateRevenueRow =>
  ({
    id: 'r-1',
    partnerId: 'p-amazon',
    amountPaise: 12500,
    attributedClickId: null,
    reportedAt: new Date('2025-02-02T00:00:00Z'),
    createdAt: new Date('2025-02-02T00:00:00Z'),
    updatedAt: new Date('2025-02-02T00:00:00Z'),
    ...overrides,
  }) as AffiliateRevenueRow;

const buildSvc = (overrides: {
  clickById?: AffiliateClickRow | null;
  createdClick?: AffiliateClickRow;
  createdRevenue?: AffiliateRevenueRow;
  partner?: AffiliatePartnerRow | null;
  revenueSum?: number;
  revenueByPartner?: { partnerId: string; totalPaise: number }[];
} = {}) => {
  const clicks = {
    create: jest.fn().mockResolvedValue(overrides.createdClick ?? clickRow()),
    findById: jest.fn().mockResolvedValue(overrides.clickById ?? null),
    countByPartner: jest.fn(),
  } as unknown as AffiliateClickRepository;
  const revenue = {
    create: jest.fn().mockResolvedValue(overrides.createdRevenue ?? revenueRow()),
    sumByPartner: jest.fn().mockResolvedValue(overrides.revenueSum ?? 0),
    aggregateByPartner: jest.fn().mockResolvedValue(overrides.revenueByPartner ?? []),
  } as unknown as AffiliateRevenueRepository;
  const partners = {
    findById: jest.fn().mockResolvedValue(overrides.partner ?? null),
    findByName: jest.fn(),
    findActive: jest.fn(),
    findActiveByName: jest.fn(),
    create: jest.fn(),
    setActive: jest.fn(),
  } as unknown as AffiliatePartnerRepository;
  return { svc: new AffiliateTrackingService(clicks, revenue, partners), clicks, revenue, partners };
};

describe('AffiliateTrackingService.logClick', () => {
  it('persists a click row when the partner is known', async () => {
    const created = clickRow();
    const { svc, clicks } = buildSvc({ partner: partnerRow(), createdClick: created });

    const result = await svc.logClick('u-1', {
      sourceProductEan: 'src',
      alternativeProductEan: 'alt',
      partnerId: 'p-amazon',
    });
    expect(result.id).toBe('c-1');
    expect(clicks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u-1',
        partnerId: 'p-amazon',
        sourceProductEan: 'src',
        alternativeProductEan: 'alt',
      }),
    );
  });

  it('rejects clicks against an unknown partner', async () => {
    const { svc } = buildSvc({ partner: null });
    await expect(
      svc.logClick('u-1', {
        sourceProductEan: 'src',
        alternativeProductEan: 'alt',
        partnerId: 'p-missing',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a null userId for anonymised clicks', async () => {
    const { svc, clicks } = buildSvc({ partner: partnerRow() });
    await svc.logClick(null, {
      sourceProductEan: 'src',
      alternativeProductEan: 'alt',
      partnerId: 'p-amazon',
    });
    expect(clicks.create).toHaveBeenCalledWith(expect.objectContaining({ userId: null }));
  });
});

describe('AffiliateTrackingService.recordRevenue', () => {
  it('records revenue when partner exists and no click is attributed', async () => {
    const created = revenueRow({ amountPaise: 9900 });
    const { svc, revenue } = buildSvc({ partner: partnerRow(), createdRevenue: created });

    const result = await svc.recordRevenue({
      partnerId: 'p-amazon',
      amountPaise: 9900,
    });
    expect(result.amountPaise).toBe(9900);
    expect(revenue.create).toHaveBeenCalledWith(
      expect.objectContaining({ partnerId: 'p-amazon', attributedClickId: null }),
    );
  });

  it('rejects revenue for an unknown partner', async () => {
    const { svc } = buildSvc({ partner: null });
    await expect(
      svc.recordRevenue({ partnerId: 'p-missing', amountPaise: 100 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects revenue when attributedClickId belongs to another partner', async () => {
    const { svc } = buildSvc({
      partner: partnerRow(),
      clickById: clickRow({ partnerId: 'p-other' }),
    });
    await expect(
      svc.recordRevenue({
        partnerId: 'p-amazon',
        amountPaise: 100,
        attributedClickId: 'c-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects revenue when attributedClickId is unknown', async () => {
    const { svc } = buildSvc({ partner: partnerRow(), clickById: null });
    await expect(
      svc.recordRevenue({
        partnerId: 'p-amazon',
        amountPaise: 100,
        attributedClickId: 'c-missing',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('uses the supplied reportedAt when provided', async () => {
    const { svc, revenue } = buildSvc({ partner: partnerRow() });
    await svc.recordRevenue({
      partnerId: 'p-amazon',
      amountPaise: 500,
      reportedAt: '2025-03-10T12:00:00.000Z',
    });
    const call = (revenue.create as jest.Mock).mock.calls[0][0];
    expect(call.reportedAt).toEqual(new Date('2025-03-10T12:00:00.000Z'));
  });
});

describe('AffiliateTrackingService.aggregateRevenueByPartner', () => {
  it('passes aggregations through from the repository', async () => {
    const expected = [{ partnerId: 'p-amazon', totalPaise: 5000 }];
    const { svc, revenue } = buildSvc({ revenueByPartner: expected });
    const since = new Date('2025-01-01');
    const until = new Date('2025-02-01');

    const result = await svc.aggregateRevenueByPartner(since, until);
    expect(result).toEqual(expected);
    expect(revenue.aggregateByPartner).toHaveBeenCalledWith(since, until);
  });
});

describe('AffiliateTrackingService.verifyWebhookSignature', () => {
  const signOf = (body: string, secret: string): string =>
    createHmac('sha256', secret).update(body).digest('hex');

  it('accepts a valid raw-hex signature', () => {
    const { svc } = buildSvc();
    const body = '{"partnerId":"p-amazon","amountPaise":1000}';
    const sig = signOf(body, 'topsecret');
    expect(() => svc.verifyWebhookSignature(body, sig, 'topsecret')).not.toThrow();
  });

  it('accepts a `sha256=` prefixed signature (GitHub-style)', () => {
    const { svc } = buildSvc();
    const body = '{"partnerId":"p-amazon","amountPaise":1000}';
    const sig = `sha256=${signOf(body, 'topsecret')}`;
    expect(() => svc.verifyWebhookSignature(body, sig, 'topsecret')).not.toThrow();
  });

  it('rejects a tampered body', () => {
    const { svc } = buildSvc();
    const sig = signOf('original', 'topsecret');
    expect(() => svc.verifyWebhookSignature('tampered', sig, 'topsecret')).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a signature signed with the wrong secret', () => {
    const { svc } = buildSvc();
    const body = 'payload';
    const sig = signOf(body, 'wrong');
    expect(() => svc.verifyWebhookSignature(body, sig, 'topsecret')).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a missing signature', () => {
    const { svc } = buildSvc();
    expect(() => svc.verifyWebhookSignature('payload', '', 'topsecret')).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a malformed (wrong-length) signature without throwing on the buffer', () => {
    const { svc } = buildSvc();
    expect(() => svc.verifyWebhookSignature('payload', 'abc123', 'topsecret')).toThrow(
      UnauthorizedException,
    );
  });
});
