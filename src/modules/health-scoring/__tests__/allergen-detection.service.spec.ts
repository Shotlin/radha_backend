import type { ProductNutritionRow, ProductRow } from '@/db/schema/products';

import { AllergenDetectionService } from '../services/allergen-detection.service';
import type { UserAllergenProfile } from '../types/health.types';

const product = (overrides: Partial<ProductRow> = {}): ProductRow =>
  ({
    id: 'p-1',
    tenantId: null,
    ean: '4006381333931',
    name: 'Test',
    brand: 'B',
    description: '',
    ...overrides,
  }) as unknown as ProductRow;

const nutrition = (allergens: string[]): ProductNutritionRow =>
  ({
    productId: 'p-1',
    containsAllergens: allergens,
  }) as unknown as ProductNutritionRow;

describe('AllergenDetectionService.detectAllergens', () => {
  let svc: AllergenDetectionService;
  beforeEach(() => {
    svc = new AllergenDetectionService();
  });

  it('returns declared allergens with severity=severe and source=declared', () => {
    const result = svc.detectAllergens(product(), nutrition(['peanuts', 'milk']));
    expect(result).toHaveLength(2);
    expect(result.find((a) => a.allergen === 'peanuts')).toMatchObject({
      severity: 'severe',
      source: 'declared',
    });
  });

  it('strips OFF language prefixes (en:peanuts → peanuts)', () => {
    const result = svc.detectAllergens(product(), nutrition(['en:Peanuts', 'fr:lait']));
    const tags = result.map((a) => a.allergen).sort();
    expect(tags).toEqual(['lait', 'peanuts']);
  });

  it('infers allergens from description text when undeclared', () => {
    const result = svc.detectAllergens(
      product({
        description: 'Contains peanuts and wheat flour. May contain traces of milk.',
      }),
      undefined,
    );
    const tags = result.map((a) => a.allergen);
    expect(tags).toContain('peanuts');
    expect(tags).toContain('milk');
    expect(tags).toContain('gluten');
    // Inferred entries should report severity=moderate, source=detected
    expect(result.find((a) => a.allergen === 'peanuts')?.source).toBe('detected');
  });

  it('returns an empty array when nothing is declared and no keywords match', () => {
    const result = svc.detectAllergens(product(), nutrition([]));
    expect(result).toEqual([]);
  });

  it('output is deterministic (sorted alphabetically)', () => {
    const result = svc.detectAllergens(product(), nutrition(['eggs', 'milk', 'peanuts']));
    expect(result.map((a) => a.allergen)).toEqual(['eggs', 'milk', 'peanuts']);
  });
});

describe('AllergenDetectionService.matchUserAllergens', () => {
  let svc: AllergenDetectionService;
  beforeEach(() => {
    svc = new AllergenDetectionService();
  });

  it('returns no matches when profile is null', () => {
    const result = svc.matchUserAllergens(
      [{ allergen: 'peanuts', severity: 'severe', source: 'declared' }],
      null,
    );
    expect(result).toEqual([]);
  });

  it('matches profile-level tags (case insensitive)', () => {
    const profile: UserAllergenProfile = {
      id: 'a-1',
      userId: 'u-1',
      tags: ['Peanuts'],
      members: [],
    };
    const result = svc.matchUserAllergens(
      [{ allergen: 'peanuts', severity: 'severe', source: 'declared' }],
      profile,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ allergen: 'peanuts', severity: 'severe' });
  });

  it('attaches family member metadata for per-member matches', () => {
    const profile: UserAllergenProfile = {
      id: 'a-1',
      userId: 'u-1',
      tags: [],
      members: [
        { id: 'm-1', name: 'Riya', tags: ['milk'], severity: 'severe' },
        { id: 'm-2', name: 'Aarav', tags: ['eggs'], severity: 'mild' },
      ],
    };
    const result = svc.matchUserAllergens(
      [
        { allergen: 'milk', severity: 'severe', source: 'declared' },
        { allergen: 'peanuts', severity: 'severe', source: 'declared' },
      ],
      profile,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      allergen: 'milk',
      familyMemberId: 'm-1',
      familyMemberName: 'Riya',
      severity: 'severe',
    });
  });
});
