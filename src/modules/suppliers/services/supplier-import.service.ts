import { Injectable, Logger } from '@nestjs/common';

import { ValidationException } from '@/common/errors/business.exception';
import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';
import type { NewSupplier } from '@/db/schema/suppliers';

import { CreateSupplierSchema } from '../dto/create-supplier.dto';
import { SuppliersRepository } from '../repositories/suppliers.repository';
import type { ImportResult, ImportRowError } from '../types/supplier.types';

const MAX_ROWS = 10_000;

type XlsxModule = typeof import('xlsx');

interface RawRow {
  rowNumber: number;
  data: Record<string, string>;
}

/**
 * BE-25 — Bulk supplier import.
 *
 * Accepts an XLSX (or CSV — read via xlsx as well, matching BE-15's
 * lazy-load pattern) file buffer and creates suppliers row-by-row.
 *
 * Behaviour:
 *
 *   - **Row-level errors are collected, not thrown.** A single
 *     malformed row never aborts the import. The caller gets back
 *     `{ totalRows, imported, skipped, failed, errors[] }` so the
 *     front-end can show "imported 95 / 100, 5 failed" and let the
 *     user fix the invalid rows.
 *
 *   - **Skip vs fail**: a row whose `code` already exists in the
 *     tenant is *skipped* (counts toward `skipped`); a row that
 *     fails validation is *failed* (counts toward `failed` AND adds
 *     to `errors[]`).
 *
 *   - **One transaction per row.** A single bad row therefore
 *     doesn't poison the whole import, and we never cross the
 *     1-second statement-timeout for any single insert.
 *
 *   - **Duplicate detection within the file** — if two rows in the
 *     same upload carry the same `code`, the second one fails with
 *     `Duplicate code in upload`.
 */
@Injectable()
export class SupplierImportService {
  private readonly logger = new Logger(SupplierImportService.name);
  private xlsx: XlsxModule | null = null;

  constructor(
    private readonly db: DbService,
    private readonly suppliersRepo: SuppliersRepository,
  ) {}

  async processBuffer(
    tenantId: string,
    actorId: string,
    fileType: 'xlsx' | 'csv',
    buffer: Buffer,
  ): Promise<ImportResult> {
    const rows = await this.parse(buffer, fileType);
    if (rows.length === 0) {
      return { totalRows: 0, imported: 0, skipped: 0, failed: 0, errors: [] };
    }
    if (rows.length > MAX_ROWS) {
      throw new ValidationException(
        `Too many rows. Maximum supported: ${MAX_ROWS.toLocaleString()}`,
      );
    }

    const errors: ImportRowError[] = [];
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    const seenCodes = new Set<string>();

    for (const row of rows) {
      try {
        const dto = this.mapRow(row);

        // Run the same Zod schema we use on the API surface — single
        // source of truth for validation.
        const parsed = CreateSupplierSchema.safeParse(dto);
        if (!parsed.success) {
          failed++;
          for (const issue of parsed.error.issues) {
            errors.push({
              row: row.rowNumber,
              field: issue.path.join('.') || undefined,
              error: issue.message,
            });
          }
          continue;
        }

        const data = parsed.data;
        const code = data.code ?? this.generateCode(data.name);

        if (seenCodes.has(code)) {
          failed++;
          errors.push({
            row: row.rowNumber,
            field: 'code',
            error: 'Duplicate code in upload',
          });
          continue;
        }
        seenCodes.add(code);

        const existing = await this.suppliersRepo.findByCodeInTenant(code, tenantId);
        if (existing) {
          skipped++;
          continue;
        }

        if (data.gstNumber) {
          const gstClash = await this.suppliersRepo.findByGstInTenant(data.gstNumber, tenantId);
          if (gstClash) {
            skipped++;
            continue;
          }
        }

        await this.db.transaction(async (tx: Transaction) => {
          await this.suppliersRepo.bulkCreate(
            [
              {
                tenantId,
                name: data.name,
                legalName: data.legalName,
                code,
                gstNumber: data.gstNumber,
                panNumber: data.panNumber,
                category: data.category,
                description: data.description,
                status: 'active',
                email: data.email,
                phone: data.phone,
                alternatePhone: data.alternatePhone,
                whatsappNumber: data.whatsappNumber,
                addressLine1: data.addressLine1,
                addressLine2: data.addressLine2,
                city: data.city,
                state: data.state,
                pincode: data.pincode,
                country: data.country,
                paymentTerms: data.paymentTerms,
                deliveryDays: data.deliveryDays,
                minimumOrderAmount: data.minimumOrderAmount?.toFixed(2),
                metadata: {
                  ...(data.metadata ?? {}),
                  importedAt: new Date().toISOString(),
                },
                createdBy: actorId,
              } satisfies NewSupplier,
            ],
            tx,
          );
        });

        imported++;
      } catch (err) {
        failed++;
        errors.push({
          row: row.rowNumber,
          error: (err as Error).message?.slice(0, 500) ?? 'unknown error',
        });
        this.logger.warn(
          `suppliers.import.row_failed row=${row.rowNumber} err=${(err as Error).message}`,
        );
      }
    }

    return {
      totalRows: rows.length,
      imported,
      skipped,
      failed,
      errors,
    };
  }

  /* ─────────────────── parsing ─────────────────── */

  /**
   * Lazy-load `xlsx` so the API process boots fast even if the
   * package is missing in dev. Mirrors BE-15's
   * `ExcelParserService.ensureModule` pattern.
   */
  private async ensureXlsx(): Promise<XlsxModule> {
    if (this.xlsx) return this.xlsx;
    const mod = (await import('xlsx').catch(() => null)) as XlsxModule | null;
    if (!mod) {
      throw new ValidationException(
        'Excel/CSV import support is not installed on this server. Install `xlsx` (`pnpm install`).',
      );
    }
    this.xlsx = mod;
    return mod;
  }

  private async parse(buffer: Buffer, fileType: 'xlsx' | 'csv'): Promise<RawRow[]> {
    const xlsx = await this.ensureXlsx();
    let workbook;
    try {
      workbook = xlsx.read(buffer, { type: 'buffer', raw: false });
    } catch (err) {
      throw new ValidationException(
        `Could not read ${fileType} file (corrupt, encrypted, or wrong format): ${
          (err as Error).message
        }`,
      );
    }
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      throw new ValidationException('File has no sheets');
    }
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      throw new ValidationException('File first sheet is empty');
    }

    const rawRows = xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      raw: false,
      defval: '',
    });
    return rawRows.map((row, index) => {
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) {
        if (v === null || v === undefined) continue;
        cleaned[normaliseHeader(k)] = String(v).trim();
      }
      return {
        rowNumber: index + 2, // +1 for header row, +1 to be 1-indexed
        data: cleaned,
      };
    });
  }

  /**
   * Map a flat sheet row → DTO shape. Header names are
   * case-insensitive and a small alias map is applied so common
   * variations ("Phone Number", "Mobile") all funnel into `phone`.
   */
  mapRow(row: RawRow): Record<string, unknown> {
    const d = row.data;
    const pick = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = d[normaliseHeader(key)];
        if (value !== undefined && value.length > 0) return value;
      }
      return undefined;
    };

    const numeric = (...keys: string[]): number | undefined => {
      const value = pick(...keys);
      if (value === undefined) return undefined;
      const parsed = Number(value.replace(/,/g, ''));
      return Number.isFinite(parsed) ? parsed : undefined;
    };

    return {
      name: pick('name', 'supplier_name', 'vendor_name'),
      legalName: pick('legal_name', 'legalname', 'legal'),
      code: pick('code', 'supplier_code')?.toUpperCase(),
      gstNumber: pick('gst', 'gst_number', 'gstin')?.toUpperCase(),
      panNumber: pick('pan', 'pan_number', 'pan_no')?.toUpperCase(),
      category: pick('category', 'type'),
      description: pick('description', 'notes'),
      email: pick('email', 'email_id')?.toLowerCase(),
      phone: pick('phone', 'phone_number', 'mobile', 'contact'),
      alternatePhone: pick('alternate_phone', 'alt_phone'),
      whatsappNumber: pick('whatsapp', 'whatsapp_number'),
      addressLine1: pick('address', 'address_line_1', 'address1'),
      addressLine2: pick('address_line_2', 'address2'),
      city: pick('city'),
      state: pick('state'),
      pincode: pick('pincode', 'pin_code', 'zip'),
      country: pick('country') ?? 'IN',
      paymentTerms: pick('payment_terms', 'terms'),
      deliveryDays: numeric('delivery_days', 'lead_time'),
      minimumOrderAmount: numeric('minimum_order_amount', 'min_order'),
    };
  }

  private generateCode(name: string): string {
    const prefix = name
      .replace(/[^A-Z0-9]/gi, '')
      .slice(0, 4)
      .toUpperCase()
      .padEnd(2, 'X');
    const suffix = Date.now().toString().slice(-6);
    return `SUP-${prefix}-${suffix}`;
  }
}

const normaliseHeader = (h: string): string =>
  h
    .toLowerCase()
    .trim()
    .replace(/[\s.-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
