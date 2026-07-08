import type { AffiliatePartnerRow } from '@/db/schema/affiliate';

import type { AffiliatePartnerRepository } from '../repositories/affiliate-partner.repository';
import { AffiliateLinkService } from '../services/affiliate-link.service';
import { HealthyAlternativesService } from '../services/healthy-alternatives.service';
import { StubProductsLookupAdapter } from '../services/stub-products-lookup.adapter';
import type { ProductCatalogEntry } from '../types/affiliate.types';

/**
 * BE-41 — `HealthyAlternativesService` unit tests.
 *
 * Drives the in-memory `StubProductsLookupAdapter` to exercise the
 * recommendation engine without hitting Drizzle. The partner
 * repository is faked through `jest.fn`s so we control which partner
 * gets picked (and whether any partner is active at all).
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

const entry = (overrides: Partial<ProductCatalogEntry> & { ean: string }): ProductCatalogEntry => ({
  name: `Product ${overrides.ean}`,
  brand: 'BrandX',
  categoryId: 'snacks',
  healthScore: 50,
  ...overrides,
});

const buildSvc = (opts: {
  catalog: ProductCatalogEntry[];
  active?: AffiliatePartnerRow[];
  byName?: AffiliatePartnerRow | null;
}) => {
  const products = new StubProductsLookupAdapter().seed(opts.catalog);
  const partners = {
    findActive: jest.fn().mockResolvedValue(opts.active ?? []),
    findActiveByName: jest.fn().mockResolvedValue(opts.byName ?? null),
    findById: jest.fn(),
    findByName: jest.fn(),
    create: jest.fn(),
    setActive: jest.fn(),
  } as unknown as AffiliatePartnerRepository;
  const linkBuilder = new AffiliateLinkService(partners);
  const svc = new HealthyAlternativesService(products, partners, linkBuilder);
  return { svc, products, partners };
};

describe('HealthyAlternativesService.recommend', () => {
  it('returns top alternatives in descending health score, capped at MAX_ALTERNATIVES', async () => {
    const source = entry({ ean: 'src', healthScore: 40 });
    const candidates = [
      entry({ ean: 'a1', healthScore: 95 }),
      entry({ ean: 'a2', healthScore: 80 }),
      entry({ ean: 'a3', healthScore: 75 }),
      entry({ ean: 'a4', healthScore: 70 }),
    ];
    const { svc } = buildSvc({
      catalog: [source, ...candidates],
      active: [partnerRow()],
    });

    const result = await svc.recommend('src');
    expect(result).toHaveLength(HealthyAlternativesService.MAX_ALTERNATIVES);
    expect(result.map((r) => r.ean)).toEqual(['a1', 'a2', 'a3']);
    expect(result[0].healthScore).toBe(95);
  });

  it('returns [] when source EAN is not in the catalog', async () => {
    const { svc } = buildSvc({ catalog: [], active: [partnerRow()] });
    expect(await svc.recommend('missing')).toEqual([]);
  });

  it('filters out candidates whose score-delta is below MIN_HEALTH_DELTA', async () => {
    const source = entry({ ean: 'src', healthScore: 60 });
    // Default delta is 10. 65 should fail; 71 should pass.
    const tooClose = entry({ ean: 'too-close', healthScore: 65 });
    const onlyValid = entry({ ean: 'valid', healthScore: 71 });
    const { svc } = buildSvc({
      catalog: [source, tooClose, onlyValid],
      active: [partnerRow()],
    });

    const result = await svc.recommend('src');
    expect(result.map((r) => r.ean)).toEqual(['valid']);
  });

  it('skips candidates from a different category', async () => {
    const source = entry({ ean: 'src', categoryId: 'snacks', healthScore: 40 });
    const sameCat = entry({ ean: 'same', categoryId: 'snacks', healthScore: 90 });
    const otherCat = entry({ ean: 'other', categoryId: 'beverages', healthScore: 95 });
    const { svc } = buildSvc({
      catalog: [source, sameCat, otherCat],
      active: [partnerRow()],
    });

    const result = await svc.recommend('src');
    expect(result.map((r) => r.ean)).toEqual(['same']);
  });

  it('returns [] when no active affiliate partner is configured', async () => {
    const source = entry({ ean: 'src', healthScore: 40 });
    const candidate = entry({ ean: 'a1', healthScore: 90 });
    const { svc } = buildSvc({
      catalog: [source, candidate],
      active: [], // no partners
    });

    expect(await svc.recommend('src')).toEqual([]);
  });

  it('honours a caller-supplied partnerName when active', async () => {
    const source = entry({ ean: 'src', healthScore: 40 });
    const candidate = entry({ ean: 'a1', healthScore: 90 });
    const flipkart = partnerRow({ id: 'p-flipkart', name: 'flipkart' });
    const { svc, partners } = buildSvc({
      catalog: [source, candidate],
      active: [partnerRow(), flipkart],
      byName: flipkart,
    });

    const result = await svc.recommend('src', { partnerName: 'flipkart' });
    expect(result[0].partnerName).toBe('flipkart');
    expect(partners.findActiveByName).toHaveBeenCalledWith('flipkart');
  });

  it('falls back to the first active partner when the requested name is inactive', async () => {
    const source = entry({ ean: 'src', healthScore: 40 });
    const candidate = entry({ ean: 'a1', healthScore: 90 });
    const amazon = partnerRow();
    const { svc } = buildSvc({
      catalog: [source, candidate],
      active: [amazon],
      byName: null, // requested partner not active
    });

    const result = await svc.recommend('src', { partnerName: 'flipkart' });
    expect(result[0].partnerName).toBe('amazon');
  });

  it('renders an affiliate link containing the candidate EAN and partner affiliate id', async () => {
    const source = entry({ ean: 'src', healthScore: 40 });
    const candidate = entry({ ean: '8901234567890', healthScore: 90 });
    const { svc } = buildSvc({
      catalog: [source, candidate],
      active: [partnerRow({ affiliateId: 'radha-21' })],
    });

    const [first] = await svc.recommend('src');
    expect(first.affiliateLink).toContain('8901234567890');
    expect(first.affiliateLink).toContain('radha-21');
  });
});
