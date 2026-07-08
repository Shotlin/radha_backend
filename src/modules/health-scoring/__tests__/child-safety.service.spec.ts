import type { ProductNutritionRow, ProductRow } from '@/db/schema/products';

import { ChildSafetyService } from '../services/child-safety.service';

const product = (): ProductRow =>
  ({
    id: 'p-1',
    tenantId: null,
    ean: '4006381333931',
    name: 'Test',
    brand: 'B',
  }) as unknown as ProductRow;

const nutrition = (
  overrides: Partial<Record<keyof ProductNutritionRow, unknown>> = {},
): ProductNutritionRow =>
  ({
    productId: 'p-1',
    sugars: null,
    fat: null,
    saturatedFat: null,
    transFat: null,
    sodium: null,
    isProcessed: null,
    ...overrides,
  }) as unknown as ProductNutritionRow;

describe('ChildSafetyService.evaluateForChildren', () => {
  let svc: ChildSafetyService;
  beforeEach(() => {
    svc = new ChildSafetyService();
  });

  it('returns unknown when nutrition is missing', () => {
    const r = svc.evaluateForChildren({ product: product() });
    expect(r.status).toBe('unknown');
    expect(r.reasons).toContain('Nutrition data unavailable');
  });

  it('returns suitable for clean nutrition', () => {
    const r = svc.evaluateForChildren({
      product: product(),
      nutrition: nutrition({ sugars: '2', fat: '3', sodium: '50' }),
    });
    expect(r.status).toBe('suitable');
    expect(r.ageRecommendation).toBe('child');
  });

  it('returns caution at borderline levels', () => {
    const r = svc.evaluateForChildren({
      product: product(),
      nutrition: nutrition({ sugars: '12', sodium: '200' }),
    });
    expect(r.status).toBe('caution');
    expect(r.reasons.some((x) => x.includes('sugar'))).toBe(true);
  });

  it('returns unsuitable for very high sugar', () => {
    const r = svc.evaluateForChildren({
      product: product(),
      nutrition: nutrition({ sugars: '25' }),
    });
    expect(r.status).toBe('unsuitable');
    expect(r.ageRecommendation).toBeUndefined();
  });

  it('hard-fails on any trans fat', () => {
    const r = svc.evaluateForChildren({
      product: product(),
      nutrition: nutrition({ transFat: '0.5', sugars: '1', fat: '1' }),
    });
    expect(r.status).toBe('unsuitable');
  });
});

describe('ChildSafetyService.classifyAgeBands', () => {
  let svc: ChildSafetyService;
  beforeEach(() => {
    svc = new ChildSafetyService();
  });

  it('marks every band unsafe when nutrition is missing', () => {
    const r = svc.classifyAgeBands({ product: product() });
    expect(r.infantSafe).toBe(false);
    expect(r.toddlerSafe).toBe(false);
    expect(r.childSafe).toBe(false);
    expect(r.adolescentSafe).toBe(false);
  });

  it('marks every band unsafe on trans fat', () => {
    const r = svc.classifyAgeBands({
      product: product(),
      nutrition: nutrition({ transFat: '0.5', sugars: '1', fat: '1' }),
    });
    expect(r.infantSafe).toBe(false);
    expect(r.adolescentSafe).toBe(false);
    expect(r.rationale).toContain('trans fat');
  });

  it('infant 0-2 fails on any added sugar', () => {
    const r = svc.classifyAgeBands({
      product: product(),
      nutrition: nutrition({ sugars: '5', fat: '5', sodium: '20' }),
    });
    expect(r.infantSafe).toBe(false);
    // Toddler still ok — under 5g sugar threshold? No, sugars=5 == toddler ceiling (<= 5).
    expect(r.toddlerSafe).toBe(true);
  });

  it('child band passes within v1 thresholds', () => {
    const r = svc.classifyAgeBands({
      product: product(),
      nutrition: nutrition({
        sugars: '8',
        fat: '10',
        saturatedFat: '3',
        sodium: '300',
      }),
    });
    expect(r.childSafe).toBe(true);
    expect(r.adolescentSafe).toBe(true);
  });

  it('adolescent band fails on extreme sodium', () => {
    const r = svc.classifyAgeBands({
      product: product(),
      nutrition: nutrition({ sugars: '5', fat: '5', sodium: '700' }),
    });
    expect(r.adolescentSafe).toBe(false);
  });
});
