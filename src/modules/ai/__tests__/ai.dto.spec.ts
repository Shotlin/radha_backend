import {
  ImageFallbackRequestSchema,
  IngredientExplanationQuerySchema,
  IngredientSlugSchema,
  LabelAnalyzeRequestSchema,
  LimitCheckQuerySchema,
  OcrRequestSchema,
  ReportSummaryRequestSchema,
  UsageQuerySchema,
} from '../dto/ai.dto';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';

describe('OcrRequestSchema', () => {
  it('accepts mediaId only', () => {
    const out = OcrRequestSchema.parse({ mediaId: VALID_UUID });
    expect(out.mediaId).toBe(VALID_UUID);
    expect(out.fallbackToPaid).toBe(false);
    expect(out.language).toBe('en');
  });

  it('rejects non-UUID mediaId', () => {
    expect(() => OcrRequestSchema.parse({ mediaId: 'not-a-uuid' })).toThrow();
  });

  it('caps preExtractedText at 5000 chars', () => {
    expect(() =>
      OcrRequestSchema.parse({
        mediaId: VALID_UUID,
        preExtractedText: 'x'.repeat(5001),
      }),
    ).toThrow();
    expect(() =>
      OcrRequestSchema.parse({
        mediaId: VALID_UUID,
        preExtractedText: 'x'.repeat(5000),
      }),
    ).not.toThrow();
  });

  it('confidence must be between 0 and 1', () => {
    expect(() =>
      OcrRequestSchema.parse({ mediaId: VALID_UUID, preExtractedConfidence: 1.5 }),
    ).toThrow();
    expect(() =>
      OcrRequestSchema.parse({ mediaId: VALID_UUID, preExtractedConfidence: -0.1 }),
    ).toThrow();
  });

  it('rejects unknown fields (strict)', () => {
    expect(() => OcrRequestSchema.parse({ mediaId: VALID_UUID, unknown: 'x' })).toThrow();
  });
});

describe('LabelAnalyzeRequestSchema / ImageFallbackRequestSchema', () => {
  it('accepts a UUID mediaId only', () => {
    expect(() => LabelAnalyzeRequestSchema.parse({ mediaId: VALID_UUID })).not.toThrow();
    expect(() => ImageFallbackRequestSchema.parse({ mediaId: VALID_UUID })).not.toThrow();
  });

  it('rejects extra fields', () => {
    expect(() => LabelAnalyzeRequestSchema.parse({ mediaId: VALID_UUID, foo: 1 })).toThrow();
  });
});

describe('ReportSummaryRequestSchema', () => {
  it('accepts a small summary object', () => {
    const out = ReportSummaryRequestSchema.parse({
      reportType: 'expiry',
      summary: { totalScans: 10, matchedScans: 8 },
    });
    expect(out.reportType).toBe('expiry');
  });

  it('rejects payloads over the byte cap', () => {
    const huge: Record<string, string> = {};
    for (let i = 0; i < 100; i += 1) huge[`k${i}`] = 'x'.repeat(500);
    expect(() => ReportSummaryRequestSchema.parse({ summary: huge })).toThrow();
  });
});

describe('IngredientSlugSchema', () => {
  it('accepts kebab-case slugs', () => {
    expect(IngredientSlugSchema.parse('palm-oil')).toBe('palm-oil');
    expect(IngredientSlugSchema.parse('sugar')).toBe('sugar');
    expect(IngredientSlugSchema.parse('e-621')).toBe('e-621');
  });

  it('rejects spaces, uppercase, and overly long input', () => {
    expect(() => IngredientSlugSchema.parse('Palm Oil')).toThrow();
    expect(() => IngredientSlugSchema.parse('PALMOIL')).toThrow();
    expect(() => IngredientSlugSchema.parse('a'.repeat(101))).toThrow();
  });
});

describe('IngredientExplanationQuerySchema', () => {
  it('defaults locale to en', () => {
    const out = IngredientExplanationQuerySchema.parse({});
    expect(out.locale).toBe('en');
  });

  it('accepts hi, en-US, etc.', () => {
    expect(IngredientExplanationQuerySchema.parse({ locale: 'hi' }).locale).toBe('hi');
    expect(IngredientExplanationQuerySchema.parse({ locale: 'en-US' }).locale).toBe('en-US');
  });

  it('rejects invalid locale', () => {
    expect(() => IngredientExplanationQuerySchema.parse({ locale: '12' })).toThrow();
    expect(() => IngredientExplanationQuerySchema.parse({ locale: 'XYZ' })).toThrow();
  });
});

describe('UsageQuerySchema', () => {
  it('accepts ISO from / to', () => {
    expect(() =>
      UsageQuerySchema.parse({ from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' }),
    ).not.toThrow();
  });

  it('rejects when from > to', () => {
    expect(() =>
      UsageQuerySchema.parse({ from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }),
    ).toThrow();
  });
});

describe('LimitCheckQuerySchema', () => {
  it('accepts known operations', () => {
    expect(() => LimitCheckQuerySchema.parse({ operation: 'ocr-expiry' })).not.toThrow();
    expect(() =>
      LimitCheckQuerySchema.parse({ operation: 'ingredient-explanation' }),
    ).not.toThrow();
  });

  it('rejects unknown operations', () => {
    expect(() => LimitCheckQuerySchema.parse({ operation: 'mining-bitcoin' })).toThrow();
  });
});
