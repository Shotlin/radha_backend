import { OffMapperService } from '../off-mapper.service';
import type { OffProduct } from '../off.types';

const NUTELLA: OffProduct = {
  code: '3017620422003',
  product_name: 'Nutella',
  product_name_en: 'Nutella',
  brands: 'Ferrero',
  categories_tags: ['en:spreads', 'en:sweet-spreads', 'en:hazelnut-spreads'],
  image_front_url: 'https://images.openfoodfacts.org/x.jpg',
  ingredients_text: 'Sugar, palm oil, hazelnuts, cocoa, milk, lecithin, vanillin.',
  allergens_tags: ['en:milk', 'en:nuts'],
  nova_group: 4,
  quantity: '750 g',
  manufacturing_places: 'Italy',
  nutriments: {
    energy_kcal_100g: 539,
    proteins_100g: 6.3,
    carbohydrates_100g: 57.5,
    sugars_100g: 56.3,
    fat_100g: 30.9,
    'saturated-fat_100g': 10.6,
    fiber_100g: 0,
    salt_100g: 0.107,
  },
};

describe('OffMapperService.mapToProduct', () => {
  const mapper = new OffMapperService();

  it('maps the headline fields from a Nutella-shaped response', () => {
    const result = mapper.mapToProduct(NUTELLA);
    expect(result).toMatchObject({
      ean: '3017620422003',
      name: 'Nutella',
      brand: 'Ferrero',
      imageUrl: 'https://images.openfoodfacts.org/x.jpg',
      packageSize: '750',
      packageUnit: 'g',
      dataSource: 'open_food_facts',
      externalId: '3017620422003',
    });
    expect(result.category).toBe('Spreads');
    expect(result.subCategory).toBe('Sweet Spreads');
  });

  it('uses the bare EAN as fallback name when nothing matches', () => {
    const result = mapper.mapToProduct({ code: '111' } as OffProduct);
    expect(result.name).toBe('Product 111');
  });
});

describe('OffMapperService.mapToNutrition', () => {
  const mapper = new OffMapperService();

  it('returns null when nutriments are absent', () => {
    expect(mapper.mapToNutrition({ code: '111' } as OffProduct)).toBeNull();
  });

  it('returns null when nutriments has no recognised macros', () => {
    expect(mapper.mapToNutrition({ code: '111', nutriments: {} } as OffProduct)).toBeNull();
  });

  it('maps the macros, converts sodium from g to mg, and tags processing level', () => {
    const result = mapper.mapToNutrition(NUTELLA);
    expect(result).not.toBeNull();
    expect(result?.calories).toBe(539);
    expect(result?.sugars).toBe(56.3);
    expect(result?.servingSize).toBe(100);
    expect(result?.servingUnit).toBe('g');
    expect(result?.isProcessed).toBe('ultra'); // NOVA 4
    expect(result?.containsAllergens).toEqual(['milk', 'nuts']);
    // Sodium derived from salt (no explicit sodium): 0.107 g salt × 0.3934 ≈ 0.0421 g = 42.1 mg
    expect(result?.sodium).toBeCloseTo(42.1, 1);
    expect(result?.confidence).toBeGreaterThanOrEqual(0.85);
  });
});

describe('OffMapperService.detectProcessingLevel', () => {
  const mapper = new OffMapperService();
  it.each<[number | undefined, 'not' | 'lightly' | 'ultra']>([
    [1, 'not'],
    [2, 'not'],
    [3, 'lightly'],
    [4, 'ultra'],
  ])('NOVA group %s → %s', (nova, expected) => {
    expect(mapper.detectProcessingLevel({ code: 'x', nova_group: nova } as OffProduct)).toBe(
      expected,
    );
  });
});
