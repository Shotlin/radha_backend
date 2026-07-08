import { CsvExporterService } from '../exporters/csv-exporter.service';

describe('CsvExporterService', () => {
  let svc: CsvExporterService;

  beforeEach(() => {
    svc = new CsvExporterService();
  });

  describe('generate', () => {
    it('emits a header row by default', async () => {
      const out = await svc.generate([
        { ean: '123', name: 'A' },
        { ean: '456', name: 'B' },
      ]);
      const text = out.toString('utf8');
      expect(text.split('\r\n')[0]).toBe('ean,name');
      expect(text).toContain('123,A');
      expect(text).toContain('456,B');
    });

    it('omits the header row when header:false', async () => {
      const out = await svc.generate([{ a: 1, b: 2 }], { header: false });
      const text = out.toString('utf8');
      expect(text.split('\r\n')[0]).toBe('1,2');
    });

    it('quotes fields containing the delimiter', async () => {
      const out = await svc.generate([{ a: 'red, yellow', b: 'plain' }]);
      const lines = out.toString('utf8').split('\r\n');
      expect(lines[1]).toBe('"red, yellow",plain');
    });

    it('doubles embedded quotes (RFC 4180)', async () => {
      const out = await svc.generate([{ a: 'she said "hi"' }]);
      const lines = out.toString('utf8').split('\r\n');
      expect(lines[1]).toBe('"she said ""hi"""');
    });

    it('quotes fields containing newlines', async () => {
      const out = await svc.generate([{ a: 'line1\nline2' }]);
      const lines = out.toString('utf8').split('\r\n');
      expect(lines[1]).toBe('"line1\nline2"');
    });

    it('sanitises formula-injection vectors', async () => {
      const out = await svc.generate([{ a: '=cmd|/c calc' }, { a: '+1+1' }]);
      const text = out.toString('utf8');
      // Apostrophe must come BEFORE the formula trigger.
      expect(text).toContain("'=cmd|/c calc");
      expect(text).toContain("'+1+1");
    });

    it('returns just a BOM for an empty rows array when bom requested', async () => {
      const out = await svc.generate([], { bom: true });
      // UTF-8 BOM = EF BB BF
      expect(out[0]).toBe(0xef);
      expect(out[1]).toBe(0xbb);
      expect(out[2]).toBe(0xbf);
    });

    it('returns an empty buffer when no rows and no bom', async () => {
      const out = await svc.generate([]);
      expect(out.length).toBe(0);
    });

    it('renders unicode (Hindi, emoji) round-trip', async () => {
      const out = await svc.generate([{ name: 'दूध 🥛', count: 2 }]);
      const text = out.toString('utf8');
      expect(text).toContain('दूध 🥛');
      expect(text).toContain('2');
    });

    it('flattens Date values to ISO strings', async () => {
      const d = new Date('2026-06-01T00:00:00Z');
      const out = await svc.generate([{ when: d }]);
      const text = out.toString('utf8');
      expect(text).toContain('2026-06-01T00:00:00.000Z');
    });

    it('uses configurable delimiter', async () => {
      const out = await svc.generate([{ a: 1, b: 2 }], { delimiter: ';' });
      const text = out.toString('utf8');
      expect(text).toContain('a;b');
      expect(text).toContain('1;2');
    });
  });

  describe('stream', () => {
    async function consume(stream: NodeJS.ReadableStream): Promise<string> {
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer | string>) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      return Buffer.concat(chunks).toString('utf8');
    }

    async function* mkRows(rows: Record<string, unknown>[]) {
      for (const r of rows) yield r;
    }

    it('yields a header row plus body rows', async () => {
      const text = await consume(svc.stream(mkRows([{ a: 1 }, { a: 2 }])));
      expect(text.split('\r\n').filter(Boolean)).toEqual(['a', '1', '2']);
    });

    it('emits a BOM only on the first chunk', async () => {
      const text = await consume(svc.stream(mkRows([{ a: 1 }]), { bom: true }));
      // BOM is prefixed once; no duplicate appears mid-stream.
      const occurrences = text.split('\uFEFF').length - 1;
      expect(occurrences).toBe(1);
    });

    it('emits BOM-only output for an empty source when bom requested', async () => {
      const text = await consume(svc.stream(mkRows([]), { bom: true }));
      expect(text).toBe('\uFEFF');
    });
  });
});
