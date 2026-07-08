import { OcrService } from '../services/ocr.service';

describe('OcrService', () => {
  const svc = new OcrService();

  it('fromPreExtracted wraps text into an OcrResult envelope', () => {
    const out = svc.fromPreExtracted({
      preExtractedText: 'hello world',
      preExtractedConfidence: 0.9,
    });
    expect(out.success).toBe(true);
    expect(out.text).toBe('hello world');
    expect(out.confidence).toBe(0.9);
    expect(out.provider).toBe('mlkit');
    expect(out.cost).toBe(0);
  });

  it('fromPreExtracted returns success=false on empty text', () => {
    const out = svc.fromPreExtracted({ preExtractedText: '' });
    expect(out.success).toBe(false);
  });

  it('fromPreExtracted defaults confidence to 0.8', () => {
    const out = svc.fromPreExtracted({ preExtractedText: 'x' });
    expect(out.confidence).toBe(0.8);
  });

  it('extractDates routes to the parser util', () => {
    const out = svc.extractDates('EXP 31/12/2026');
    expect(out).toHaveLength(1);
  });

  it('extractNumbers routes to the parser util', () => {
    const out = svc.extractNumbers('Lot 1234');
    expect(out).toEqual(['1234']);
  });

  it('extractEans routes to the parser util', () => {
    const out = svc.extractEans('Code 3017620422003');
    expect(out).toEqual(['3017620422003']);
  });
});
