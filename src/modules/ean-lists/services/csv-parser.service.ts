import { Injectable, Logger } from '@nestjs/common';

import { ValidationException } from '@/common/errors/business.exception';

import type { ParsedRow } from '../types/import.types';

import { extractRowFields } from './row-mapper.utils';

const MAX_ROWS = 50_000;

// `csv-parse/sync` is loaded dynamically.
type CsvSyncModule = typeof import('csv-parse/sync');

/**
 * BE-15 — CSV parser. Lazy-loads `csv-parse/sync` for the same
 * reasons as the Excel parser.
 */
@Injectable()
export class CsvParserService {
  private readonly logger = new Logger(CsvParserService.name);
  private parseFn: CsvSyncModule['parse'] | null = null;

  async parseBuffer(buffer: Buffer): Promise<ParsedRow[]> {
    const parse = await this.ensureParser();
    let records: Record<string, unknown>[];
    try {
      records = parse(buffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        bom: true,
      }) as Record<string, unknown>[];
    } catch (err) {
      this.logger.warn(`csv.parse.failed: ${(err as Error).message}`);
      throw new ValidationException(`Could not parse CSV file: ${(err as Error).message}`);
    }
    if (records.length === 0) {
      throw new ValidationException('CSV file is empty');
    }
    if (records.length > MAX_ROWS) {
      throw new ValidationException(`CSV file too large. Max ${MAX_ROWS.toLocaleString()} rows.`);
    }

    return records.map((row, index) => {
      const stringRow = this.toStringRow(row);
      const extracted = extractRowFields(stringRow);
      return {
        rowNumber: index + 2,
        ean: extracted.ean,
        productName: extracted.productName,
        brand: extracted.brand,
        notes: extracted.notes,
        rawData: stringRow,
      };
    });
  }

  private async ensureParser(): Promise<CsvSyncModule['parse']> {
    if (this.parseFn) return this.parseFn;
    const mod = (await import('csv-parse/sync').catch(() => null)) as CsvSyncModule | null;
    if (!mod) {
      throw new ValidationException(
        'CSV support is not installed on this server. Run `pnpm install` to enable CSV imports.',
      );
    }
    this.parseFn = mod.parse;
    return mod.parse;
  }

  private toStringRow(row: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) {
      if (v === null || v === undefined) continue;
      out[k] = String(v).trim();
    }
    return out;
  }
}
