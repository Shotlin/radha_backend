import { OcrDateValidatorService } from '../services/ocr-date-validator.service';

const svc = new OcrDateValidatorService();

describe('OcrDateValidatorService.validate — happy paths', () => {
  it('parses DD/MM/YYYY (Indian retail label default)', () => {
    const r = svc.validate('EXP: 31/12/2030', 0.9);
    expect(r.valid).toBe(true);
    expect(r.format).toBe('DD-MM-YYYY');
    expect(r.date?.getUTCFullYear()).toBe(2030);
    expect(r.date?.getUTCMonth()).toBe(11);
    expect(r.date?.getUTCDate()).toBe(31);
  });

  it('parses DD-MM-YYYY with hyphens', () => {
    const r = svc.validate('Best before 15-08-2028', 0.85);
    expect(r.valid).toBe(true);
    expect(r.date?.getUTCFullYear()).toBe(2028);
  });

  it('parses MM/YYYY (rolls to last day of month)', () => {
    const r = svc.validate('EXP 02/2028', 0.95);
    expect(r.valid).toBe(true);
    expect(r.format).toBe('MM-YYYY');
    expect(r.date?.getUTCFullYear()).toBe(2028);
    expect(r.date?.getUTCMonth()).toBe(1);
    expect(r.date?.getUTCDate()).toBe(29); // 2028 is a leap year
  });

  it('parses YYYY-MM-DD ISO format', () => {
    const r = svc.validate('2030-12-31', 0.99);
    expect(r.valid).toBe(true);
    expect(r.format).toBe('YYYY-MM-DD');
  });
});

describe('OcrDateValidatorService.validate — sanity checks', () => {
  it('flags dates more than 10 years in the past', () => {
    const r = svc.validate('05/04/2010', 0.9);
    expect(r.valid).toBe(false);
    expect(r.warning).toContain('past');
  });

  it('flags dates more than 10 years in the future', () => {
    const r = svc.validate('05/04/2099', 0.9);
    expect(r.valid).toBe(false);
    expect(r.warning).toContain('future');
  });

  it('warns on low confidence even when date is valid', () => {
    const r = svc.validate('31/12/2030', 0.5);
    expect(r.valid).toBe(true);
    expect(r.warning).toContain('Low OCR confidence');
  });

  it('rejects invalid calendar dates (Feb 30)', () => {
    const r = svc.validate('30/02/2027', 0.9);
    expect(r.valid).toBe(false);
  });
});

describe('OcrDateValidatorService.validate — bad input', () => {
  it('returns valid=false for empty string', () => {
    expect(svc.validate('', 0.9).valid).toBe(false);
  });

  it('returns valid=false when no date pattern detected', () => {
    expect(svc.validate('this label has no date', 0.9).valid).toBe(false);
  });

  it('returns valid=false for nonsense like "EXP: ----"', () => {
    expect(svc.validate('EXP: ----', 0.9).valid).toBe(false);
  });
});
