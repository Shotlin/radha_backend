import { Injectable, Logger } from '@nestjs/common';

import { ValidationException } from '@/common/errors/business.exception';

import type { ParsedRow } from '../types/import.types';

import { extractRowFields } from './row-mapper.utils';

const MAX_ROWS = 50_000;

type XlsxModule = typeof import('xlsx');

/**
 * BE-15 — Excel (.xlsx) parser.
 *
 * The `xlsx` library is loaded **lazily** the first time `parseBuffer`
 * runs. This keeps the API boot cost low (xlsx pulls in ~5 MB of code)
 * and lets the module ship in environments where `xlsx` isn't yet
 * installed — the call simply throws a typed `ValidationException`
 * instead of crashing the whole API.
 */
@Injectable()
export class ExcelParserService {
  private readonly logger = new Logger(ExcelParserService.name);
  private xlsx: XlsxModule | null = null;

  async parseBuffer(buffer: Buffer): Promise<ParsedRow[]> {
    const xlsx = await this.ensureModule();
    let workbook: ReturnType<XlsxModule['read']>;
    try {
      workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });
    } catch (err) {
      this.logger.warn(`xlsx.parse.failed: ${(err as Error).message}`);
      throw new ValidationException('Could not read Excel file (corrupt or password-protected)');
    }
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      throw new ValidationException('Excel file has no sheets');
    }
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      throw new ValidationException('Excel file first sheet is empty');
    }

    const rows = xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      raw: false,
      defval: '',
    });
    if (rows.length === 0) {
      throw new ValidationException('Excel file is empty');
    }
    if (rows.length > MAX_ROWS) {
      throw new ValidationException(`Excel file too large. Max ${MAX_ROWS.toLocaleString()} rows.`);
    }

    return rows.map((row, index) => {
      const stringRow = this.toStringRow(row);
      const extracted = extractRowFields(stringRow);
      return {
        rowNumber: index + 2, // header is row 1
        ean: extracted.ean,
        productName: extracted.productName,
        brand: extracted.brand,
        notes: extracted.notes,
        rawData: stringRow,
      };
    });
  }

  private async ensureModule(): Promise<XlsxModule> {
    if (this.xlsx) return this.xlsx;
    const mod = (await import('xlsx').catch(() => null)) as XlsxModule | null;
    if (!mod) {
      throw new ValidationException(
        'Excel support is not installed on this server. Run `pnpm install` to enable .xlsx imports, or upload as CSV.',
      );
    }
    this.xlsx = mod;
    return mod;
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
