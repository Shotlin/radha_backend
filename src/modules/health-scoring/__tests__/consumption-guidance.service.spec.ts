import type { ProductNutritionRow, ProductRow } from '@/db/schema/products';

import { ConsumptionGuidanceService } from '../services/consumption-guidance.service';
import type { ScoringInput, ScoringOutput } from '../types/health.types';

const product = (): ProductRow =>
  ({
    id: 'p-1',
    tenantId: null,
    ean: '4006381333931',
    name: 'Test',
    brand: 'B',
  }) as unknown as ProductRow;

const baseOutput = (overrides: Partial<ScoringOutput> = {}): ScoringOutput => ({
  productId: 'p-1',
  overallGrade: 'A',
  overallScore: 90,
  healthStatus: 'green',
  childSafety: { status: 'suitable', reasons: [] },
  warnings: [],
  positives: [],
  allergens: [],
  isProcessed: 'not',
  tags: [],
  ruleVersion: '1.0.0',
  computedAt: new Date(),
  ...overrides,
});

describe('ConsumptionGuidanceService.generate', () => {
  let svc: ConsumptionGuidanceService;
  beforeEach(() => {
    svc = new ConsumptionGuidanceService();
  });

  it('grade A → daily cadence', () => {
    const input: ScoringInput = { product: product(), nutrition: null };
    const guide = svc.generate(input, baseOutput({ overallGrade: 'A' }));
    expect(guide.cadence).toBe('daily');
    expect(guide.summary).toContain('daily');
  });

  it('grade E → avoid', () => {
    const input: ScoringInput = { product: product(), nutrition: null };
    const guide = svc.generate(input, baseOutput({ overallGrade: 'E', overallScore: 10 }));
    expect(guide.cadence).toBe('avoid');
  });

  it('data_unavailable → occasional with warning text', () => {
    const input: ScoringInput = { product: product(), nutrition: null };
    const guide = svc.generate(
      input,
      baseOutput({ overallGrade: 'U', healthStatus: 'data_unavailable', overallScore: 50 }),
    );
    expect(guide.cadence).toBe('occasional');
    expect(guide.summary).toContain('unavailable');
  });

  it('emits trans-fat warning text when present', () => {
    const input: ScoringInput = { product: product(), nutrition: null };
    const guide = svc.generate(
      input,
      baseOutput({
        overallGrade: 'D',
        warnings: [
          {
            type: 'trans_fat',
            severity: 'high',
            message: 'Contains trans fat',
            threshold: 0,
            actual: 1,
            unit: 'g/100g',
          },
        ],
      }),
    );
    expect(guide.notes.some((n) => n.toLowerCase().includes('trans fat'))).toBe(true);
  });

  it('uses serving size as portion when present', () => {
    const input: ScoringInput = {
      product: product(),
      nutrition: { servingSize: '30' } as unknown as ProductNutritionRow,
    };
    const guide = svc.generate(input, baseOutput());
    expect(guide.portionGrams).toBe(30);
  });

  it('omits portion when serving size is missing', () => {
    const input: ScoringInput = { product: product(), nutrition: null };
    const guide = svc.generate(input, baseOutput());
    expect(guide.portionGrams).toBeUndefined();
  });
});
