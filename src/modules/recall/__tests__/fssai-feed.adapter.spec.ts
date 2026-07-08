import { LoggerService } from '@/logging/logger.service';

import { FssaiFeedAdapter } from '../integrations/fssai-feed.adapter';

describe('FssaiFeedAdapter', () => {
  const buildLogger = (): LoggerService =>
    ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      verbose: jest.fn(),
    }) as unknown as LoggerService;

  describe('mock mode (no fetchUrl set)', () => {
    it('returns at least one mock entry shaped correctly', async () => {
      const adapter = new FssaiFeedAdapter(buildLogger());
      const entries = await adapter.fetch();

      expect(entries.length).toBeGreaterThan(0);
      const first = entries[0];
      expect(first.source).toBe('fssai');
      expect(first.reason).toEqual(expect.any(String));
      expect(first.recalledAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(first.raw).toBeDefined();
    });

    it('returns the same entries on repeated calls (no hidden state)', async () => {
      const adapter = new FssaiFeedAdapter(buildLogger());
      const a = await adapter.fetch();
      const b = await adapter.fetch();
      expect(b.length).toBe(a.length);
    });
  });

  describe('http mode', () => {
    class TestAdapter extends FssaiFeedAdapter {
      public stub: Response | null = null;
      constructor(logger: LoggerService, url: string) {
        super(logger);
        (this as unknown as { fetchUrl: string }).fetchUrl = url;
      }
      protected async request(_url: string): Promise<Response> {
        if (!this.stub) throw new Error('no stub');
        return this.stub;
      }
    }

    const buildResponse = (status: number, body: unknown): Response =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      }) as unknown as Response;

    it('parses entries from the upstream response', async () => {
      const adapter = new TestAdapter(buildLogger(), 'https://feed.example/fssai');
      adapter.stub = buildResponse(200, {
        entries: [
          {
            ean: '8901058000016',
            brand: 'TestCo',
            product_name: 'Cereal',
            batch_number: 'B-1',
            reason: 'Contamination',
            recalled_at: '2025-01-15',
          },
        ],
      });

      const result = await adapter.fetch();
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        source: 'fssai',
        ean: '8901058000016',
        brand: 'TestCo',
        productName: 'Cereal',
        batchNumber: 'B-1',
        reason: 'Contamination',
        recalledAt: '2025-01-15',
      });
    });

    it('throws when upstream returns non-2xx', async () => {
      const adapter = new TestAdapter(buildLogger(), 'https://feed.example/fssai');
      adapter.stub = buildResponse(503, {});

      await expect(adapter.fetch()).rejects.toThrow(/503/);
    });

    it('throws when payload is missing entries array', async () => {
      const adapter = new TestAdapter(buildLogger(), 'https://feed.example/fssai');
      adapter.stub = buildResponse(200, {});

      await expect(adapter.fetch()).rejects.toThrow(/entries/);
    });

    it('skips malformed rows but keeps valid ones', async () => {
      const adapter = new TestAdapter(buildLogger(), 'https://feed.example/fssai');
      adapter.stub = buildResponse(200, {
        entries: [
          { /* missing reason */ recalled_at: '2025-01-15' },
          {
            reason: 'Contamination',
            recalled_at: '2025-01-15',
            ean: '111',
          },
          null,
        ],
      });

      const result = await adapter.fetch();
      expect(result).toHaveLength(1);
      expect(result[0].ean).toBe('111');
    });
  });
});
