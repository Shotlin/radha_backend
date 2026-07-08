import { isNormalisedIngredientSlug, normaliseIngredientSlug } from '../utils/slug.util';

describe('normaliseIngredientSlug', () => {
  it('lowercases mixed-case input', () => {
    expect(normaliseIngredientSlug('Sodium Benzoate')).toBe('sodium-benzoate');
  });

  it('replaces non-alphanumeric runs with a single hyphen', () => {
    expect(normaliseIngredientSlug('high   fructose__corn  syrup')).toBe(
      'high-fructose-corn-syrup',
    );
  });

  it('trims leading and trailing hyphens', () => {
    expect(normaliseIngredientSlug('---salt---')).toBe('salt');
  });

  it('strips diacritics', () => {
    expect(normaliseIngredientSlug('Açaí Berry')).toBe('acai-berry');
  });

  it('returns empty string for null / undefined / empty input', () => {
    expect(normaliseIngredientSlug(null)).toBe('');
    expect(normaliseIngredientSlug(undefined)).toBe('');
    expect(normaliseIngredientSlug('')).toBe('');
    expect(normaliseIngredientSlug('   ')).toBe('');
  });

  it('returns empty string when input becomes empty after sanitisation', () => {
    expect(normaliseIngredientSlug('!!!@#$%')).toBe('');
  });

  it('preserves digits', () => {
    expect(normaliseIngredientSlug('Vitamin B12')).toBe('vitamin-b12');
    expect(normaliseIngredientSlug('E-330')).toBe('e-330');
  });

  it('collapses multiple hyphens into one', () => {
    expect(normaliseIngredientSlug('palm---oil')).toBe('palm-oil');
  });

  it('is idempotent', () => {
    const once = normaliseIngredientSlug('Mono Sodium Glutamate');
    const twice = normaliseIngredientSlug(once);
    expect(once).toBe('mono-sodium-glutamate');
    expect(twice).toBe(once);
  });

  it('handles Unicode whitespace and punctuation', () => {
    expect(normaliseIngredientSlug('palm\u00A0oil — refined')).toBe('palm-oil-refined');
  });

  // Property test: any string in, never crashes, output always
  // matches the contract or is empty.
  it('property: never crashes and always emits a valid kebab slug or empty', () => {
    const samples: Array<unknown> = [
      'normal',
      '',
      ' ',
      'A B C',
      'Mixed_Case-Slug',
      '🌶 chilli',
      '日本語',
      'a'.repeat(1024),
      '!@#$%^&*()',
      '\n\t\r',
      'multi   spaces',
      '--double--hyphens--',
    ];
    for (const sample of samples) {
      const out = normaliseIngredientSlug(sample as string | null | undefined);
      expect(typeof out).toBe('string');
      if (out) {
        expect(isNormalisedIngredientSlug(out)).toBe(true);
      }
    }
  });
});

describe('isNormalisedIngredientSlug', () => {
  it('accepts valid lowercase kebab-case alphanumeric slugs', () => {
    expect(isNormalisedIngredientSlug('palm-oil')).toBe(true);
    expect(isNormalisedIngredientSlug('vitamin-b12')).toBe(true);
    expect(isNormalisedIngredientSlug('salt')).toBe(true);
    expect(isNormalisedIngredientSlug('a1')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isNormalisedIngredientSlug('')).toBe(false);
  });

  it('rejects uppercase', () => {
    expect(isNormalisedIngredientSlug('Palm-Oil')).toBe(false);
  });

  it('rejects leading or trailing hyphens', () => {
    expect(isNormalisedIngredientSlug('-salt')).toBe(false);
    expect(isNormalisedIngredientSlug('salt-')).toBe(false);
  });

  it('rejects consecutive hyphens', () => {
    expect(isNormalisedIngredientSlug('palm--oil')).toBe(false);
  });

  it('rejects non-alphanumeric characters', () => {
    expect(isNormalisedIngredientSlug('palm_oil')).toBe(false);
    expect(isNormalisedIngredientSlug('palm oil')).toBe(false);
    expect(isNormalisedIngredientSlug('palm.oil')).toBe(false);
  });
});
