import { DbService } from '@/db/db.service';
import { LoggerService } from '@/logging/logger.service';
import { ProductsRepository } from '@/modules/products/products.repository';

import { EanListItemsRepository } from '../repositories/ean-list-items.repository';
import { EanListsRepository } from '../repositories/ean-lists.repository';
import { ImportBatchesRepository } from '../repositories/import-batches.repository';
import { ImportErrorsRepository } from '../repositories/import-errors.repository';
import { CsvParserService } from '../services/csv-parser.service';
import { ExcelParserService } from '../services/excel-parser.service';
import { ImportProcessorService } from '../services/import-processor.service';
import type { ParsedRow } from '../types/import.types';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const buildSvc = () => {
  const logger = buildLogger();
  const excel = {} as unknown as ExcelParserService;
  const csv = {} as unknown as CsvParserService;
  const items = {} as unknown as EanListItemsRepository;
  const lists = {} as unknown as EanListsRepository;
  const batches = {} as unknown as ImportBatchesRepository;
  const errors = {} as unknown as ImportErrorsRepository;
  const products = {} as unknown as ProductsRepository;
  const db = {} as unknown as DbService;

  const svc = new ImportProcessorService(
    db,
    logger,
    excel,
    csv,
    items,
    lists,
    batches,
    errors,
    products,
  );
  return { svc };
};

describe('ImportProcessorService.validateRows', () => {
  it('separates valid + invalid rows and normalises EANs', () => {
    const { svc } = buildSvc();
    const rows: ParsedRow[] = [
      {
        rowNumber: 2,
        ean: '8901030789885',
        productName: 'Maggi',
        rawData: { ean: '8901030789885' },
      },
      { rowNumber: 3, ean: 'abc', rawData: { ean: 'abc' } },
      { rowNumber: 4, ean: '', rawData: {} },
      // EAN-13 with intentional invalid check digit
      { rowNumber: 5, ean: '8901030789880', rawData: { ean: '8901030789880' } },
    ];
    const { valid, invalid } = svc.validateRows(rows);
    expect(valid).toHaveLength(1);
    expect(valid[0]?.ean).toBe('8901030789885');
    expect(invalid).toHaveLength(3);
    expect(invalid[0]?.errors[0]).toContain('Invalid EAN');
    expect(invalid[1]?.errors[0]).toContain('required');
  });

  it('flags duplicates within the same file pointing at first occurrence', () => {
    const { svc } = buildSvc();
    const rows: ParsedRow[] = [
      { rowNumber: 2, ean: '8901030789885', rawData: { ean: '8901030789885' } },
      { rowNumber: 7, ean: '8901030789885', rawData: { ean: '8901030789885' } },
    ];
    const { valid, invalid } = svc.validateRows(rows);
    expect(valid).toHaveLength(1);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.rowNumber).toBe(7);
    expect(invalid[0]?.errors[0]).toContain('row 2');
  });

  it('treats UPC-A and EAN-13 forms of the same code as duplicates after normalisation', () => {
    const { svc } = buildSvc();
    // 614141000043 (UPC-A) becomes 0614141000043 (EAN-13)
    const rows: ParsedRow[] = [
      { rowNumber: 2, ean: '0614141000043', rawData: {} },
      { rowNumber: 3, ean: '614141000043', rawData: {} },
    ];
    const { valid, invalid } = svc.validateRows(rows);
    expect(valid).toHaveLength(1);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.errors[0]).toContain('row 2');
  });

  it('preserves productName / brand / notes on valid rows', () => {
    const { svc } = buildSvc();
    const rows: ParsedRow[] = [
      {
        rowNumber: 2,
        ean: '8901030789885',
        productName: 'Maggi',
        brand: 'Nestle',
        notes: 'family pack',
        rawData: {},
      },
    ];
    const { valid } = svc.validateRows(rows);
    expect(valid[0]).toMatchObject({
      ean: '8901030789885',
      productName: 'Maggi',
      brand: 'Nestle',
      notes: 'family pack',
      rowNumber: 2,
    });
  });

  it('returns empty result for empty input', () => {
    const { svc } = buildSvc();
    expect(svc.validateRows([])).toEqual({ valid: [], invalid: [] });
  });
});
