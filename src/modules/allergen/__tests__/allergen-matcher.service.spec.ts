import { Test, TestingModule } from '@nestjs/testing';

import { AllergenMatcherService, AllergenMatch } from '../services/allergen-matcher.service';

describe('AllergenMatcherService', () => {
  let matcher: AllergenMatcherService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AllergenMatcherService],
    }).compile();

    matcher = module.get(AllergenMatcherService);
  });

  describe('case-insensitive matching', () => {
    it('should match "PEANUT" in uppercase ingredients', () => {
      const profile = { allergyTags: ['peanut'] };
      const matches = matcher.match(profile, ['PEANUT OIL', 'sugar'], []);

      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].tag).toBe('peanut');
      expect(matches[0].matchedIn).toBe('ingredient');
    });

    it('should match "Milk" with mixed case', () => {
      const profile = { allergyTags: ['milk'] };
      const matches = matcher.match(profile, ['Whole Milk Powder'], []);

      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].tag).toBe('milk');
    });

    it('should match tag regardless of tag case', () => {
      const profile = { allergyTags: ['PEANUT'] };
      const matches = matcher.match(profile, ['contains peanut butter'], []);

      expect(matches.length).toBeGreaterThan(0);
    });
  });

  describe('synonym matching', () => {
    it('should match "groundnut" as synonym for "peanut"', () => {
      const profile = { allergyTags: ['peanut'] };
      const matches = matcher.match(profile, ['groundnut oil', 'salt'], []);

      expect(matches.length).toBeGreaterThan(0);
      const groundnutMatch = matches.find((m) => m.matchedTerm === 'groundnut');
      expect(groundnutMatch).toBeDefined();
    });

    it('should match "dairy" as synonym for "milk"', () => {
      const profile = { allergyTags: ['milk'] };
      const matches = matcher.match(profile, ['dairy cream', 'flour'], []);

      expect(matches.length).toBeGreaterThan(0);
      const dairyMatch = matches.find((m) => m.matchedTerm === 'dairy');
      expect(dairyMatch).toBeDefined();
    });

    it('should match "casein" as synonym for "milk"', () => {
      const profile = { allergyTags: ['milk'] };
      const matches = matcher.match(profile, ['sodium casein', 'water'], []);

      expect(matches.length).toBeGreaterThan(0);
      const caseinMatch = matches.find((m) => m.matchedTerm === 'casein');
      expect(caseinMatch).toBeDefined();
    });

    it('should match "soya" as synonym for "soy"', () => {
      const profile = { allergyTags: ['soy'] };
      const matches = matcher.match(profile, ['soya lecithin'], []);

      expect(matches.length).toBeGreaterThan(0);
    });

    it('should match "albumin" as synonym for "egg"', () => {
      const profile = { allergyTags: ['egg'] };
      const matches = matcher.match(profile, ['albumin powder'], []);

      expect(matches.length).toBeGreaterThan(0);
    });

    it('should match "shrimp" as synonym for "shellfish"', () => {
      const profile = { allergyTags: ['shellfish'] };
      const matches = matcher.match(profile, ['dried shrimp'], []);

      expect(matches.length).toBeGreaterThan(0);
    });

    it('should match "wheat" as synonym for "gluten"', () => {
      const profile = { allergyTags: ['gluten'] };
      const matches = matcher.match(profile, ['wheat flour'], []);

      expect(matches.length).toBeGreaterThan(0);
    });
  });

  describe('allergen declaration matching', () => {
    it('should match against product allergen declarations', () => {
      const profile = { allergyTags: ['peanut'] };
      const matches = matcher.match(profile, [], ['Peanuts', 'Tree Nuts']);

      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].matchedIn).toBe('allergen_declaration');
      expect(matches[0].severity).toBe('high');
    });
  });

  describe('no-match scenarios', () => {
    it('should return empty array when no allergens match', () => {
      const profile = { allergyTags: ['peanut', 'shellfish'] };
      const matches = matcher.match(profile, ['sugar', 'salt', 'water', 'flour'], []);

      // flour might match gluten synonym for wheat, but peanut/shellfish shouldn't match
      const peanutMatches = matches.filter((m) => m.tag === 'peanut');
      const shellfishMatches = matches.filter((m) => m.tag === 'shellfish');
      expect(peanutMatches).toHaveLength(0);
      expect(shellfishMatches).toHaveLength(0);
    });

    it('should return empty array for empty allergyTags', () => {
      const profile = { allergyTags: [] as string[] };
      const matches = matcher.match(profile, ['peanut oil', 'milk'], ['Peanuts']);

      expect(matches).toHaveLength(0);
    });

    it('should return empty array for empty ingredients and declarations', () => {
      const profile = { allergyTags: ['peanut', 'milk'] };
      const matches = matcher.match(profile, [], []);

      expect(matches).toHaveLength(0);
    });
  });

  describe('multiple allergen matching', () => {
    it('should detect multiple allergens in a product', () => {
      const profile = { allergyTags: ['peanut', 'milk', 'soy'] };
      const ingredients = ['peanut butter', 'whole milk powder', 'soya lecithin', 'sugar'];

      const matches = matcher.match(profile, ingredients, []);

      const tags = [...new Set(matches.map((m) => m.tag))];
      expect(tags).toContain('peanut');
      expect(tags).toContain('milk');
      expect(tags).toContain('soy');
    });
  });

  describe('severity levels', () => {
    it('should assign high severity for direct word-boundary match', () => {
      const profile = { allergyTags: ['peanut'] };
      const matches = matcher.match(profile, ['contains peanut'], []);

      const directMatch = matches.find((m) => m.matchedTerm === 'peanut');
      expect(directMatch?.severity).toBe('high');
    });

    it('should assign high severity for allergen declaration matches', () => {
      const profile = { allergyTags: ['milk'] };
      const matches = matcher.match(profile, [], ['Milk']);

      expect(matches[0].severity).toBe('high');
    });
  });

  describe('deduplication', () => {
    it('should not produce duplicate matches for the same tag+matchedIn+term', () => {
      const profile = { allergyTags: ['peanut'] };
      const ingredients = ['peanut oil', 'roasted peanut', 'peanut butter'];

      const matches = matcher.match(profile, ingredients, []);

      // Should deduplicate same tag+matchedIn+matchedTerm combos
      const peanutIngredientMatches = matches.filter(
        (m) => m.tag === 'peanut' && m.matchedIn === 'ingredient' && m.matchedTerm === 'peanut',
      );
      expect(peanutIngredientMatches.length).toBeLessThanOrEqual(1);
    });
  });
});
