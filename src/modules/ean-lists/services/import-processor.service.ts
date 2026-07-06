import { Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';
import { DbService } from '@/db/db.service';
import { ProductsRepository } from '@/modules/products/products.repository';
import { validateEan } from '@/modules/products/utils/ean.utils';

import { EanListItemsRepository } from '../repositories/ean-list-items.repository';
import { EanListsRepository } from '../repositories/ean-lists.repository';
import { ImportBatchesRepository } from '../repositories/import-batches.repository';
import { ImportErrorsRepository } from '../repositories/import-errors.repository';
import type { FileType, InvalidRow, ParsedRow, ValidatedRow } from '../types/import.types';

import { CsvParserService } from './csv-parser.service';
import { ExcelParserService } from './excel-parser.service';

const INSERT_CHUNK_SIZE = 1000;
const ERROR_CHUNK_SIZE = 500;

/**
 * BE-15 — Import orchestrator.
 *
 * v1 runs synchronously inside the API request that initiated the
 * upload. This is acceptable up to ~5 K rows in < 5 s. For larger
 * files the BE-24 phase will introduce a BullMQ queue and shift this
 * call into a worker process — `processImport(batchId)` already takes
 * just a batchId argument so the queue payload is the smallest
 * possible and re-entrancy works out of the box.
 *
 * The class boundary is intentional:
 *   - parsing (Excel / CSV) is delegated,
 *   - validation is pure (idempotent, testable),
 *   - persistence is chunked (1 K items per insert),
 *   - errors are recorded in 500-row chunks,
 *   - status transitions are persisted at every checkpoint so a
 *     crash mid-import leaves an inspectable `processing` row.
 */
@Injectable()
export class ImportProcessorService {
  constructor(
    private readonly db: DbService,
    private readonly logger: LoggerService,
    private readonly excelParser: ExcelParserService,
    private readonly csvParser: CsvParserService,
    private readonly itemsRepo: EanListItemsRepository,
    private readonly listsRepo: EanListsRepository,
    private readonly batchesRepo: ImportBatchesRepository,
    private readonly errorsRepo: ImportErrorsRepository,
    private readonly productsRepo: ProductsRepository,
  ) {}

  /**
   * Drive an import end-to-end given a batch id and the raw file
   * buffer. The batch row must already be in `queued` status.
   */
  async processImport(batchId: string, buffer: Buffer): Promise<void> {
    const batch = await this.batchesRepo.findById(batchId);
    if (!batch) throw new Error(`Import batch not found: ${batchId}`);
    if (batch.status !== 'queued') {
      throw new Error(`Batch ${batchId} is in status ${batch.status}, expected 'queued'`);
    }

    try {
      await this.batchesRepo.update(batchId, {
        status: 'processing',
        startedAt: new Date(),
      });

      const rows = await this.parseFile(buffer, batch.fileType as FileType);
      await this.batchesRepo.update(batchId, { totalRows: rows.length });

      const { valid, invalid } = this.validateRows(rows);

      let inserted = 0;
      if (batch.listId) {
        for (let i = 0; i < valid.length; i += INSERT_CHUNK_SIZE) {
          const chunk = valid.slice(i, i + INSERT_CHUNK_SIZE);
          const count = await this.insertItems(batch.listId, chunk);
          inserted += count;
          await this.batchesRepo.update(batchId, {
            processedRows: i + chunk.length,
            validRows: inserted,
          });
        }
      }

      if (invalid.length > 0) {
        await this.recordErrors(batchId, invalid);
        await this.batchesRepo.update(batchId, { invalidRows: invalid.length });
      }

      if (batch.listId && inserted > 0) {
        await this.listsRepo.incrementCounters(batch.listId, {
          totalItems: inserted,
          validatedItems: inserted,
        });
      }

      await this.batchesRepo.update(batchId, {
        status: 'completed',
        completedAt: new Date(),
        processedRows: rows.length,
      });

      this.logger.info('ean.import.completed', {
        batchId,
        total: rows.length,
        valid: inserted,
        invalid: invalid.length,
      });
    } catch (err) {
      this.logger.error('ean.import.failed', {
        batchId,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      await this.batchesRepo.update(batchId, {
        status: 'failed',
        completedAt: new Date(),
        errorMessage: (err as Error).message?.slice(0, 1000) ?? 'unknown error',
      });
      throw err;
    }
  }

  async parseFile(buffer: Buffer, fileType: FileType): Promise<ParsedRow[]> {
    if (fileType === 'xlsx') return this.excelParser.parseBuffer(buffer);
    return this.csvParser.parseBuffer(buffer);
  }

  /**
   * Pure validation. Returns the bisection of (valid, invalid) so the
   * caller can persist each set independently.
   */
  validateRows(rows: ParsedRow[]): { valid: ValidatedRow[]; invalid: InvalidRow[] } {
    const valid: ValidatedRow[] = [];
    const invalid: InvalidRow[] = [];
    const seen = new Map<string, number>(); // EAN → first-seen rowNumber

    for (const row of rows) {
      const errors: string[] = [];

      if (!row.ean || row.ean.length === 0) {
        errors.push('EAN is required');
      } else {
        const result = validateEan(row.ean);
        if (!result.valid || !result.normalised) {
          errors.push(result.error ?? 'Invalid EAN');
        } else {
          const normalised = result.normalised;
          const firstAt = seen.get(normalised);
          if (firstAt !== undefined) {
            errors.push(`Duplicate EAN — first seen at row ${firstAt}`);
          } else {
            seen.set(normalised, row.rowNumber);
            valid.push({
              ean: normalised,
              productName: row.productName,
              brand: row.brand,
              notes: row.notes,
              rowNumber: row.rowNumber,
            });
            continue;
          }
        }
      }

      invalid.push({
        rowNumber: row.rowNumber,
        rawData: row.rawData,
        errors,
      });
    }
    return { valid, invalid };
  }

  async insertItems(listId: string, rows: ValidatedRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    return this.db.transaction(async (tx) => {
      // Try to match imported EANs to global / tenant products in a
      // single round-trip. Match on EAN regardless of tenant — the
      // catalog row may already exist as a global OFF row.
      const eans = rows.map((r) => r.ean);
      const matched = await this.productsRepo.findManyByEans(eans, null);
      const productByEan = new Map<string, string>();
      for (const p of matched) productByEan.set(p.ean, p.id);

      const items = rows.map((row) => ({
        listId,
        ean: row.ean,
        productId: productByEan.get(row.ean) ?? null,
        productName: row.productName,
        brand: row.brand,
        notes: row.notes,
        rowNumber: row.rowNumber,
        rawData: { ean: row.ean, productName: row.productName, brand: row.brand },
      }));
      const inserted = await this.itemsRepo.bulkInsert(items, tx);
      return inserted.length;
    });
  }

  async recordErrors(batchId: string, errors: InvalidRow[]): Promise<void> {
    if (errors.length === 0) return;
    for (let i = 0; i < errors.length; i += ERROR_CHUNK_SIZE) {
      const chunk = errors.slice(i, i + ERROR_CHUNK_SIZE);
      await this.errorsRepo.bulkInsert(
        chunk.map((e) => ({
          batchId,
          rowNumber: e.rowNumber,
          rawData: e.rawData,
          errors: e.errors,
        })),
      );
    }
  }
}
