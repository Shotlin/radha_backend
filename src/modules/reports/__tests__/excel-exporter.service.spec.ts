import { LoggerService } from '@/logging/logger.service';

import { ExcelExporterService } from '../exporters/excel-exporter.service';
import type { ExcelOptions } from '../types/export.types';

/**
 * Tests use a hand-rolled in-memory ExcelJS stand-in so we can assert
 * structural decisions (sheet ordering, header styling, conditional
 * formatting wiring) without taking a real `exceljs` dep at test
 * time. The production wiring in the service uses the real package
 * via dynamic import.
 */

interface FakeRow {
  font?: Record<string, unknown>;
  fill?: Record<string, unknown>;
  alignment?: Record<string, unknown>;
  values?: Record<string, unknown>;
}

interface FakeSheet {
  name: string;
  columns: Array<{ header: string; key: string; width?: number }>;
  rows: FakeRow[];
  views?: Array<{ state?: 'frozen'; xSplit?: number; ySplit?: number }>;
  autoFilter?: unknown;
  conditionalRules?: Array<{ ref: string; rules: unknown[] }>;
}

class FakeWorkbook {
  creator = '';
  created!: Date;
  lastModifiedBy = '';
  worksheets: FakeSheet[] = [];

  addWorksheet(name: string): FakeSheet & {
    addRow: (row: unknown) => FakeRow;
    addRows: (rows: unknown[]) => FakeRow[];
    getRow: (n: number) => FakeRow;
    addConditionalFormatting: (rule: { ref: string; rules: unknown[] }) => void;
    rowCount: number;
  } {
    const sheet: FakeSheet = {
      name,
      columns: [],
      rows: [{ font: {}, fill: {}, alignment: {} }], // header placeholder
      conditionalRules: [],
    };
    this.worksheets.push(sheet);

    const handle = {
      ...sheet,
      get rowCount() {
        return sheet.rows.length;
      },
      addRow: (row: unknown) => {
        const r: FakeRow = { values: row as Record<string, unknown> };
        sheet.rows.push(r);
        return r;
      },
      addRows: (rows: unknown[]) => rows.map((r) => handle.addRow(r)),
      getRow: (n: number) => sheet.rows[n - 1] ?? sheet.rows[0]!,
      addConditionalFormatting: (rule: { ref: string; rules: unknown[] }) => {
        sheet.conditionalRules!.push(rule);
      },
    };
    Object.defineProperty(handle, 'columns', {
      get: () => sheet.columns,
      set: (v) => {
        sheet.columns = v as FakeSheet['columns'];
      },
    });
    Object.defineProperty(handle, 'views', {
      get: () => sheet.views,
      set: (v) => {
        sheet.views = v as FakeSheet['views'];
      },
    });
    Object.defineProperty(handle, 'autoFilter', {
      get: () => sheet.autoFilter,
      set: (v) => {
        sheet.autoFilter = v;
      },
    });
    return handle as unknown as FakeSheet & {
      addRow: (row: unknown) => FakeRow;
      addRows: (rows: unknown[]) => FakeRow[];
      getRow: (n: number) => FakeRow;
      addConditionalFormatting: (rule: { ref: string; rules: unknown[] }) => void;
      rowCount: number;
    };
  }

  xlsx = {
    writeBuffer: async (): Promise<Buffer> =>
      Buffer.from(JSON.stringify({ sheets: this.worksheets.map((s) => s.name) }), 'utf8'),
  };
}

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const baseOptions: ExcelOptions = {
  title: 'Expiry Q1',
  generatedAt: new Date('2026-06-01T00:00:00Z'),
  generatedBy: 'user-1',
  tenantName: 'Acme',
};

describe('ExcelExporterService.generate', () => {
  let svc: ExcelExporterService;
  let captured: FakeWorkbook | null = null;

  beforeEach(() => {
    captured = null;
    svc = new ExcelExporterService(buildLogger());
    const loader = (async () => ({
      Workbook: function CapturedWorkbook(this: FakeWorkbook) {
        const wb = new FakeWorkbook();
        captured = wb;
        return wb;
      } as unknown as new () => FakeWorkbook,
    })) as unknown as Parameters<typeof svc.__setModuleLoader>[0];
    svc.__setModuleLoader(loader);
  });

  it('emits Report Info + data sheets', async () => {
    await svc.generate({ rows: [{ ean: '1', name: 'A' }] }, baseOptions);
    expect(captured!.worksheets.map((s) => s.name)).toEqual(['Report Info', 'Report']);
  });

  it('inserts a Summary sheet when summary is non-empty', async () => {
    await svc.generate(
      { rows: [{ a: 1 }], summary: { totalScans: 100, redCount: 2 } },
      baseOptions,
    );
    expect(captured!.worksheets.map((s) => s.name)).toEqual(['Report Info', 'Summary', 'Report']);
  });

  it('uses provided sheets when present (multi-sheet)', async () => {
    await svc.generate(
      {
        rows: [],
        sheets: [
          { name: 'Sheet A', data: [{ x: 1 }] },
          { name: 'Sheet B', data: [{ y: 2 }] },
        ],
      },
      baseOptions,
    );
    expect(captured!.worksheets.map((s) => s.name)).toEqual(['Report Info', 'Sheet A', 'Sheet B']);
  });

  it('renders a placeholder for empty data sheets', async () => {
    await svc.generate({ rows: [] }, baseOptions);
    const data = captured!.worksheets.find((s) => s.name === 'Report')!;
    expect(data.columns[0]!.key).toBe('no_data');
  });

  it('humanises header keys', async () => {
    await svc.generate({ rows: [{ totalScans: 1, productEan: '8901' }] }, baseOptions);
    const data = captured!.worksheets.find((s) => s.name === 'Report')!;
    expect(data.columns.map((c) => c.header)).toEqual(['Total Scans', 'Product Ean']);
  });

  it('respects custom column widths', async () => {
    await svc.generate(
      { rows: [{ ean: '1', name: 'A' }] },
      { ...baseOptions, columnWidths: { name: 50 } },
    );
    const data = captured!.worksheets.find((s) => s.name === 'Report')!;
    const nameCol = data.columns.find((c) => c.key === 'name')!;
    expect(nameCol.width).toBe(50);
  });

  it('attaches conditional-formatting rules when status column exists', async () => {
    await svc.generate(
      { rows: [{ ean: '1', status: 'red' }] },
      { ...baseOptions, conditionalFormatting: true },
    );
    const data = captured!.worksheets.find((s) => s.name === 'Report')!;
    expect(data.conditionalRules!.length).toBeGreaterThan(0);
    expect(data.conditionalRules![0]!.rules).toHaveLength(3);
  });

  it('skips conditional formatting when no status column', async () => {
    await svc.generate(
      { rows: [{ ean: '1', name: 'A' }] },
      { ...baseOptions, conditionalFormatting: true },
    );
    const data = captured!.worksheets.find((s) => s.name === 'Report')!;
    expect(data.conditionalRules!.length).toBe(0);
  });

  it('truncates long sheet names to 31 characters', async () => {
    await svc.generateMultiSheet([{ name: 'a'.repeat(50), data: [{ x: 1 }] }], baseOptions);
    const sheet = captured!.worksheets[1]!;
    expect(sheet.name.length).toBeLessThanOrEqual(31);
  });

  it('substitutes "Report" for an empty sheet name', async () => {
    await svc.generateMultiSheet([{ name: '', data: [{ x: 1 }] }], baseOptions);
    expect(captured!.worksheets[1]!.name).toBe('Report');
  });

  it('throws an ExternalServiceException when exceljs missing', async () => {
    svc.__setModuleLoader(async () => {
      throw new Error('Module exceljs is not installed');
    });
    await expect(svc.generate({ rows: [{ a: 1 }] }, baseOptions)).rejects.toMatchObject({
      code: expect.stringMatching(/^E\d{4}$/),
    });
  });
});
