import { VisionOcrService } from '../services/vision-ocr.service';

describe('VisionOcrService (mock stub)', () => {
  let service: VisionOcrService;

  beforeEach(() => {
    service = new VisionOcrService();
  });

  it('returns the deterministic mock payload', async () => {
    const result = await service.recognize('uploads/abc/photo.jpg');
    expect(result).toEqual({
      name: 'Mock Cereal',
      brand: 'Mock Brand',
      confidence: 0.95,
      costPaise: 1,
      provider: 'mock',
    });
  });

  it('returns the same result regardless of locale (stub is locale-agnostic)', async () => {
    const en = await service.recognize('uploads/abc/photo.jpg', 'en');
    const hi = await service.recognize('uploads/abc/photo.jpg', 'hi');
    expect(hi).toEqual(en);
  });

  it('exposes the cost ceiling as a static constant', () => {
    expect(VisionOcrService.DEFAULT_COST_PAISE).toBe(1);
  });

  it('throws when s3ObjectKey is empty', async () => {
    await expect(service.recognize('')).rejects.toThrow(/s3ObjectKey is required/);
  });

  it('throws when s3ObjectKey is not a string', async () => {
    await expect(
      service.recognize(undefined as unknown as string),
    ).rejects.toThrow(/s3ObjectKey is required/);
  });

  it('returns a 0..1 confidence value', async () => {
    const result = await service.recognize('uploads/x.jpg');
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('returns an integer cost in paise', async () => {
    const result = await service.recognize('uploads/x.jpg');
    expect(Number.isInteger(result.costPaise)).toBe(true);
    expect(result.costPaise).toBeGreaterThanOrEqual(0);
  });
});
