import { MockAiProvider } from '../providers/mock-ai.provider';

describe('MockAiProvider', () => {
  const buf = Buffer.from('placeholder');

  it('extractText returns the canned string when no preExtractedText', async () => {
    const out = await new MockAiProvider().extractText(buf);
    expect(out.success).toBe(true);
    expect(out.provider).toBe('mock');
    expect(out.cost).toBe(0);
    expect(out.text).toContain('EXP');
  });

  it('extractText echoes preExtractedText when supplied', async () => {
    const out = await new MockAiProvider().extractText(buf, {
      preExtractedText: 'CUSTOM',
      preExtractedConfidence: 0.95,
    });
    expect(out.text).toBe('CUSTOM');
    expect(out.confidence).toBe(0.95);
  });

  it('recognise returns at least one candidate', async () => {
    const out = await new MockAiProvider().recognise(buf);
    expect(out.candidates.length).toBeGreaterThan(0);
    expect(out.provider).toBe('mock');
  });

  it('analyseLabel returns a fully-shaped label result', async () => {
    const out = await new MockAiProvider().analyseLabel(buf);
    expect(out.productName).toBeDefined();
    expect(out.brand).toBeDefined();
    expect(out.confidence).toBeGreaterThan(0);
  });

  it('complete returns deterministic mock text including locale', async () => {
    const out = await new MockAiProvider().complete('hello', { locale: 'hi' });
    expect(out.text).toContain('locale=hi');
    expect(out.cost).toBe(0);
    expect(out.provider).toBe('mock');
  });

  it('isConfigured is always true', () => {
    expect(new MockAiProvider().isConfigured()).toBe(true);
  });

  it('truncates long prompts in the mock echo', async () => {
    const long = 'x'.repeat(1000);
    const out = await new MockAiProvider().complete(long);
    expect(out.text.length).toBeLessThan(300);
  });
});
