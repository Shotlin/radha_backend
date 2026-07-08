import { detectEanFormat, normaliseEan, validateEan } from '../utils/ean.utils';

describe('detectEanFormat', () => {
  it('classifies known lengths', () => {
    expect(detectEanFormat('1234567890123')).toBe('EAN-13');
    expect(detectEanFormat('123456789012')).toBe('UPC-A');
    expect(detectEanFormat('12345678')).toBe('EAN-8');
    expect(detectEanFormat('123456')).toBe('UPC-E');
    expect(detectEanFormat('1234')).toBe('INVALID');
  });

  it('strips non-digits before classifying', () => {
    expect(detectEanFormat('123-456-789-0123')).toBe('EAN-13');
  });
});

describe('validateEan', () => {
  it('accepts a valid EAN-13', () => {
    // 8901234567890 — recompute check digit so the test data is valid
    // First 12: 890123456789, check = (10 - ((8+0+2+4+6+8 + (9+1+3+5+7+9)*3) % 10)) % 10
    // We'll use a known-good EAN: 4006381333931 (Staedtler eraser)
    expect(validateEan('4006381333931').valid).toBe(true);
  });

  it('rejects EAN-13 with wrong check digit', () => {
    const result = validateEan('4006381333932');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('check digit');
  });

  it('accepts a valid EAN-8 (45678901)', () => {
    // 4567890 → check = (10 - ((4*3+5+6*3+7+8*3+9+0*3) mod 10)) mod 10
    //         = (10 - ((12+5+18+7+24+9+0) mod 10)) mod 10 = (10 - (75 mod 10)) mod 10 = 5
    expect(validateEan('45678905').valid).toBe(true);
  });

  it('rejects EAN-8 with wrong check digit', () => {
    expect(validateEan('45678906').valid).toBe(false);
  });

  it('rejects empty / non-digit input', () => {
    expect(validateEan('').valid).toBe(false);
    expect(validateEan('abc').valid).toBe(false);
  });

  it('returns the normalised EAN-13 in the result', () => {
    // valid UPC-A: 036000291452 (Coca-Cola classic)
    const r = validateEan('036000291452');
    expect(r.valid).toBe(true);
    expect(r.format).toBe('UPC-A');
    expect(r.normalised).toBe('0036000291452');
  });
});

describe('normaliseEan', () => {
  it('keeps an EAN-13 unchanged', () => {
    expect(normaliseEan('4006381333931')).toBe('4006381333931');
  });

  it('promotes UPC-A → EAN-13 by prepending 0', () => {
    expect(normaliseEan('036000291452')).toBe('0036000291452');
  });

  it('keeps EAN-8 as 8 digits', () => {
    expect(normaliseEan('45678905')).toBe('45678905');
  });

  it('strips non-digits before normalising', () => {
    expect(normaliseEan('400-6381-333931')).toBe('4006381333931');
  });

  it('expands UPC-E to a 13-digit string (zero-padded UPC-A)', () => {
    const out = normaliseEan('123456');
    expect(out.length).toBe(13);
    expect(/^\d+$/.test(out)).toBe(true);
  });
});
