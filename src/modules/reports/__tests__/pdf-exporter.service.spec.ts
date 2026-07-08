import { LoggerService } from '@/logging/logger.service';

import { PdfExporterService } from '../exporters/pdf-exporter.service';
import type { PdfOptions } from '../types/export.types';

/**
 * The real `pdfkit` package is not required at unit-test time. We
 * inject a lightweight stand-in that records every method invocation
 * so we can assert structural decisions (header, title, summary,
 * paginated table, page numbers, watermark) without binary
 * comparisons.
 */

interface PdfCall {
  method: string;
  args: unknown[];
}

class FakePdfDocument {
  page = {
    width: 595,
    height: 842,
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
  };
  y = 50;
  calls: PdfCall[] = [];
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  private pageRange = { start: 0, count: 1 };

  on(event: string, cb: (...args: unknown[]) => void): this {
    let arr = this.listeners.get(event);
    if (!arr) {
      arr = [];
      this.listeners.set(event, arr);
    }
    arr.push(cb);
    return this;
  }
  fontSize(_size: number): this {
    this.calls.push({ method: 'fontSize', args: [_size] });
    return this;
  }
  font(_name: string): this {
    this.calls.push({ method: 'font', args: [_name] });
    return this;
  }
  fillColor(_c: string): this {
    this.calls.push({ method: 'fillColor', args: [_c] });
    return this;
  }
  strokeColor(_c: string): this {
    this.calls.push({ method: 'strokeColor', args: [_c] });
    return this;
  }
  text(...args: unknown[]): this {
    this.calls.push({ method: 'text', args });
    return this;
  }
  moveDown(_lines?: number): this {
    return this;
  }
  moveTo(_x: number, _y: number): this {
    return this;
  }
  lineTo(_x: number, _y: number): this {
    return this;
  }
  stroke(): this {
    return this;
  }
  rect(_x: number, _y: number, _w: number, _h: number): this {
    this.calls.push({ method: 'rect', args: [_x, _y, _w, _h] });
    return this;
  }
  fill(_color?: string): this {
    return this;
  }
  addPage(): this {
    this.pageRange.count += 1;
    return this;
  }
  switchToPage(_idx: number): this {
    return this;
  }
  bufferedPageRange(): { start: number; count: number } {
    return { ...this.pageRange };
  }
  widthOfString(): number {
    return 100;
  }
  end(): void {
    // emit data + end events synchronously
    const data = this.listeners.get('data') ?? [];
    const ends = this.listeners.get('end') ?? [];
    for (const cb of data) cb(Buffer.from('FAKE-PDF', 'utf8'));
    for (const cb of ends) cb();
  }
}

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const baseOptions: PdfOptions = {
  title: 'Expiry Q1',
  generatedAt: new Date('2026-06-01T00:00:00Z'),
  generatedBy: 'user-1',
  tenantName: 'Acme Foods',
};

describe('PdfExporterService.generate', () => {
  let svc: PdfExporterService;
  let captured: FakePdfDocument | null;

  beforeEach(() => {
    captured = null;
    svc = new PdfExporterService(buildLogger());
    const loader = (async () => {
      return function CapturedDoc(this: FakePdfDocument) {
        const doc = new FakePdfDocument();
        captured = doc;
        return doc;
      } as unknown as new () => FakePdfDocument;
    }) as unknown as Parameters<typeof svc.__setModuleLoader>[0];
    svc.__setModuleLoader(loader);
  });

  it('returns a non-empty buffer', async () => {
    const out = await svc.generate({ rows: [{ a: 1 }] }, baseOptions);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
  });

  it('paints title and tenant block', async () => {
    await svc.generate({ rows: [{ a: 1 }] }, baseOptions);
    const titleCall = captured!.calls.find(
      (c) => c.method === 'text' && (c.args[0] as string) === 'Expiry Q1',
    );
    expect(titleCall).toBeDefined();
    const tenantCall = captured!.calls.find(
      (c) => c.method === 'text' && c.args[0] === 'Acme Foods',
    );
    expect(tenantCall).toBeDefined();
  });

  it('renders the empty-state placeholder when data has no rows', async () => {
    await svc.generate({ rows: [] }, baseOptions);
    const placeholder = captured!.calls.find(
      (c) => c.method === 'text' && (c.args[0] as string) === '(no rows in this report)',
    );
    expect(placeholder).toBeDefined();
  });

  it('renders summary block when summary present', async () => {
    await svc.generate({ rows: [{ a: 1 }], summary: { totalScans: 42 } }, baseOptions);
    const summaryHeader = captured!.calls.find(
      (c) => c.method === 'text' && (c.args[0] as string) === 'Summary',
    );
    expect(summaryHeader).toBeDefined();
    const totalScans = captured!.calls.find(
      (c) =>
        c.method === 'text' &&
        typeof c.args[0] === 'string' &&
        (c.args[0] as string).startsWith('Total Scans:'),
    );
    expect(totalScans).toBeDefined();
  });

  it('paginates large datasets', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ idx: i }));
    await svc.generate({ rows }, baseOptions);
    // FakePdfDocument increments pageRange.count on addPage.
    expect(captured!.bufferedPageRange().count).toBeGreaterThan(1);
  });

  it('truncates beyond maxRows and adds a footer notice', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ idx: i }));
    await svc.generate({ rows }, { ...baseOptions, maxRows: 50 });
    const truncationNotice = captured!.calls.find(
      (c) =>
        c.method === 'text' &&
        typeof c.args[0] === 'string' &&
        (c.args[0] as string).includes('more rows truncated'),
    );
    expect(truncationNotice).toBeDefined();
  });

  it('paints a watermark when requested', async () => {
    await svc.generate({ rows: [{ a: 1 }] }, { ...baseOptions, watermark: 'CONFIDENTIAL' });
    const watermark = captured!.calls.find(
      (c) => c.method === 'text' && c.args[0] === 'CONFIDENTIAL',
    );
    expect(watermark).toBeDefined();
  });

  it('renders page numbers by default', async () => {
    await svc.generate({ rows: [{ a: 1 }] }, baseOptions);
    const pageNumber = captured!.calls.find(
      (c) =>
        c.method === 'text' &&
        typeof c.args[0] === 'string' &&
        (c.args[0] as string).startsWith('Page '),
    );
    expect(pageNumber).toBeDefined();
  });

  it('skips page numbers when disabled', async () => {
    await svc.generate({ rows: [{ a: 1 }] }, { ...baseOptions, pageNumbers: false });
    const pageNumber = captured!.calls.find(
      (c) =>
        c.method === 'text' &&
        typeof c.args[0] === 'string' &&
        (c.args[0] as string).startsWith('Page '),
    );
    expect(pageNumber).toBeUndefined();
  });

  it('rejects with an external-service error when pdfkit missing', async () => {
    svc.__setModuleLoader(async () => {
      throw new Error('Module pdfkit is not installed');
    });
    await expect(svc.generate({ rows: [{ a: 1 }] }, baseOptions)).rejects.toMatchObject({
      code: expect.stringMatching(/^E\d{4}$/),
    });
  });

  it('renders subtitle when provided', async () => {
    await svc.generate({ rows: [{ a: 1 }] }, { ...baseOptions, subtitle: 'For internal review' });
    const subtitle = captured!.calls.find(
      (c) => c.method === 'text' && c.args[0] === 'For internal review',
    );
    expect(subtitle).toBeDefined();
  });

  it('renders dateRange in metadata when provided', async () => {
    await svc.generate(
      { rows: [{ a: 1 }] },
      {
        ...baseOptions,
        dateRange: {
          from: new Date('2026-01-01T00:00:00Z'),
          to: new Date('2026-03-31T00:00:00Z'),
        },
      },
    );
    const range = captured!.calls.find(
      (c) =>
        c.method === 'text' &&
        typeof c.args[0] === 'string' &&
        (c.args[0] as string).includes('2026-01-01'),
    );
    expect(range).toBeDefined();
  });
});
