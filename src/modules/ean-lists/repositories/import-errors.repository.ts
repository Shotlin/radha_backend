import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { EanImportErrorRow, NewEanImportError, eanImportErrors } from '@/db/schema/ean-lists';

@Injectable()
export class ImportErrorsRepository extends BaseRepository<
  typeof eanImportErrors,
  EanImportErrorRow,
  NewEanImportError,
  Partial<NewEanImportError>
> {
  constructor(db: DbService) {
    super(db.getDb(), eanImportErrors, 'ean_import_errors');
  }

  async listForBatch(batchId: string, limit = 500): Promise<EanImportErrorRow[]> {
    return (await this.db
      .select()
      .from(eanImportErrors)
      .where(eq(eanImportErrors.batchId, batchId))
      .orderBy(asc(eanImportErrors.rowNumber))
      .limit(limit)) as EanImportErrorRow[];
  }

  async bulkInsert(rows: NewEanImportError[]): Promise<EanImportErrorRow[]> {
    if (rows.length === 0) return [];
    return (await this.db.insert(eanImportErrors).values(rows).returning()) as EanImportErrorRow[];
  }
}
