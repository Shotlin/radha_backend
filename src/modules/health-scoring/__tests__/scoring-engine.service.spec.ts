import type { ProductNutritionRow, ProductRow } from '@/db/schema/products';

import { v1Rules } from '../rules/v1-rules';
import { AllergenDetectionService } from '../services/allergen-detection.service';
import { ChildSafetyService } from '../services/child-safety.service';
import { ScoringEngineService } from '../services/scoring-engine.service';

const product = (): ProductRow =>
  ({
    id: 'p-1',
    tenantId: null,
    ean: '4006381333931',
    name: 'Test Product',
    brand: 'Brand',
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
    protein: null,
    fiber: null,
    isProcessed: null,
    containsAllergens: [],
    ...overrides,
  }) as unknown as ProductNutritionRow;

const buildEngine = (): ScoringEngineService => {
  const childSafety = new ChildSafetyService();
  const allergens = new AllergenDetectionService();
  return new ScoringEngineService(childSafety, allergens);
};

describe('ScoringEngineService.evaluate', () => {
  it('flags very high sugar with grade D and unsuitable child safety', () => {
    const engine = buildEngine();
    const out = engine.evaluate({
      product: product(),
      nutrition: nutrition({ sugars: '25', fat: '10', sodium: '200' }),
    });
    expect(out.warnings.find((w) => w.type === 'high_sugar')).toBeDefined();
    expect(out.overallScore).toBe(75); // 100 - 25 sugar penalty
    expect(out.overallGrade).toBe('B');
    expect(out.childSafety.status).toBe('unsuitable');
  });

  it('grades a healthy product as A with positives surfaced', () => {
    const engine = buildEngine();
    const out = engine.evaluate({
      product: product(),
      nutrition: nutrition({
        protein: '20',
        fiber: '8',
        sugars: '2',
        fat: '5',
        sodium: '100',
        isProcessed: 'not',
      }),
    });
    expect(out.overallGrade).toBe('A');
    expect(out.positives.find((p) => p.type === 'high_protein')).toBeDefined();
    expect(out.positives.find((p) => p.type === 'high_fiber')).toBeDefined();
    expect(out.childSafety.status).toBe('suitable');
  });

  it('marks any trans fat as a hard fail for child safety', () => {
    const engine = buildEngine();
    const out = engine.evaluate({
      product: product(),
      nutrition: nutrition({ transFat: '1', sugars: '5', fat: '8' }),
    });
    expect(out.childSafety.status).toBe('unsuitable');
    expect(out.warnings.find((w) => w.type === 'trans_fat')).toBeDefined();
    expect(out.overallScore).toBeLessThan(75);
  });

  it('returns insufficient_data when nutrition is missing', () => {
    const engine = buildEngine();
    const out = engine.evaluate({ product: product() });
    expect(out.overallGrade).toBe('U');
    expect(out.healthStatus).toBe('data_unavailable');
    expect(out.tags).toContain('insufficient_data');
  });

  it('detects ultra-processed and tags it', () => {
    const engine = buildEngine();
    const out = engine.evaluate({
      product: product(),
      nutrition: nutrition({ isProcessed: 'ultra' }),
    });
    expect(out.tags).toContain('ultra_processed');
    expect(out.warnings.find((w) => w.type === 'ultra_processed')).toBeDefined();
  });

  it('is deterministic — 100 identical runs produce identical scores', () => {
    const engine = buildEngine();
    const input = {
      product: product(),
      nutrition: nutrition({ sugars: '12', fat: '20', sodium: '500' }),
    };
    const first = engine.evaluate(input);
    for (let i = 0; i < 99; i++) {
      const next = engine.evaluate(input);
      expect(next.overallScore).toBe(first.overallScore);
      expect(next.overallGrade).toBe(first.overallGrade);
    }
  });
});

describe('ScoringEngineService.validateRules', () => {
  it('accepts the canonical v1 rule set', () => {
    const engine = buildEngine();
    const result = engine.validateRules(v1Rules);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects duplicate rule ids', () => {
    const engine = buildEngine();
    const result = engine.validateRules([v1Rules[0]!, v1Rules[0]!]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Duplicate'))).toBe(true);
  });

  it('rejects out-of-range weights', () => {
    const engine = buildEngine();
    const broken = [{ ...v1Rules[0]!, weight: 1.5 }];
    const result = engine.validateRules(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('weight'))).toBe(true);
  });
});

describe('ScoringEngineService.scoreToGrade', () => {
  it('maps score boundaries correctly', () => {
    const engine = buildEngine();
    expect(engine.scoreToGrade(95)).toBe('A');
    expect(engine.scoreToGrade(80)).toBe('A');
    expect(engine.scoreToGrade(79)).toBe('B');
    expect(engine.scoreToGrade(60)).toBe('B');
    expect(engine.scoreToGrade(59)).toBe('C');
    expect(engine.scoreToGrade(40)).toBe('C');
    expect(engine.scoreToGrade(39)).toBe('D');
    expect(engine.scoreToGrade(20)).toBe('D');
    expect(engine.scoreToGrade(19)).toBe('E');
    expect(engine.scoreToGrade(0)).toBe('E');
  });
});
