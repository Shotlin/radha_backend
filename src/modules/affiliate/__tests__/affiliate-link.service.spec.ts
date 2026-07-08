import type { AffiliatePartnerRow } from '@/db/schema/affiliate';

import type { AffiliatePartnerRepository } from '../repositories/affiliate-partner.repository';
import { AffiliateLinkService } from '../services/affiliate-link.service';

/**
 * BE-41 — `AffiliateLinkService` unit tests.
 *
 * Pure rendering + partner selection. The repository is faked because
 * the service is the only DB caller and the substitution logic itself
 * is what we want to assert.
 */

const partnerRow = (overrides: Partial<AffiliatePartnerRow> = {}): AffiliatePartnerRow =>
  ({
    id: 'p-amazon',
    name: 'amazon',
    affiliateId: 'radha-21',
    linkTemplate: 'https://www.amazon.in/dp/{ean}?tag={affiliateId}',
    hmacSecret: null,
    isActive: true,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  }) as AffiliatePartnerRow;

const buildSvc = (opts: {
  active?: AffiliatePartnerRow[];
  byName?: AffiliatePartnerRow | null;
}) => {
  const partners = {
    findActive: jest.fn().mockResolvedValue(opts.active ?? []),
    findActiveByName: jest.fn().mockResolvedValue(opts.byName ?? null),
    findById: jest.fn(),
    findByName: jest.fn(),
    create: jest.fn(),
    setActive: jest.fn(),
  } as unknown as AffiliatePartnerRepository;
  return { svc: new AffiliateLinkService(partners), partners };
};

describe('AffiliateLinkService.buildLinkWithPartner', () => {
  it('replaces both placeholders verbatim', () => {
    const { svc } = buildSvc({});
    const partner = partnerRow();
    const url = svc.buildLinkWithPartner('1234567890123', partner);
    expect(url).toBe('https://www.amazon.in/dp/1234567890123?tag=radha-21');
  });

  it('URL-encodes special characters in EAN and affiliateId', () => {
    const { svc } = buildSvc({});
    const partner = partnerRow({
      affiliateId: 'tag with space',
      linkTemplate: 'https://x.test/p/{ean}?aff={affiliateId}',
    });
    const url = svc.buildLinkWithPartner('a&b', partner);
    expect(url).toBe('https://x.test/p/a%26b?aff=tag%20with%20space');
  });

  it('replaces every occurrence of a placeholder, not just the first', () => {
    const { svc } = buildSvc({});
    const partner = partnerRow({
      linkTemplate: 'https://x.test/{ean}/ref/{ean}?tag={affiliateId}',
    });
    const url = svc.buildLinkWithPartner('111', partner);
    expect(url).toBe('https://x.test/111/ref/111?tag=radha-21');
  });
});

describe('AffiliateLinkService.buildLink', () => {
  it('returns null when no active partners exist', async () => {
    const { svc } = buildSvc({ active: [] });
    expect(await svc.buildLink('123')).toBeNull();
  });

  it('uses the first active partner when no name is supplied', async () => {
    const amazon = partnerRow();
    const flipkart = partnerRow({ id: 'p-flipkart', name: 'flipkart' });
    const { svc } = buildSvc({ active: [amazon, flipkart] });

    const result = await svc.buildLink('123');
    expect(result?.partner.name).toBe('amazon');
  });

  it('looks up by name when one is supplied', async () => {
    const flipkart = partnerRow({
      id: 'p-flipkart',
      name: 'flipkart',
      linkTemplate: 'https://www.flipkart.com/p?pid={ean}&affid={affiliateId}',
    });
    const { svc, partners } = buildSvc({ active: [], byName: flipkart });

    const result = await svc.buildLink('123', 'flipkart');
    expect(result?.partner.name).toBe('flipkart');
    expect(result?.url).toContain('pid=123');
    expect(partners.findActiveByName).toHaveBeenCalledWith('flipkart');
  });

  it('returns null when the named partner is inactive', async () => {
    const { svc } = buildSvc({ byName: null, active: [] });
    expect(await svc.buildLink('123', 'flipkart')).toBeNull();
  });
});
