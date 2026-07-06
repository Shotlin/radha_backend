import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { ImportBatchRow, NewImportBatch, importBatches } from '@/db/schema/ean-lists';

@Injectable()
export class ImportBatchesRepository extends BaseRepository<
  typeof importBatches,
  ImportBatchRow,
  NewImportBatch,
  Partial<NewImportBatch>
> {
  constructor(db: DbService) {
    super(db.getDb(), importBatches, 'import_batches');
  }

  async findByIdInTenant(id: string, tenantId: string): Promise<ImportBatchRow | null> {
    const [row] = await this.db
      .select()
      .from(importBatches)
      .where(and(eq(importBatches.id, id), eq(importBatches.tenantId, tenantId)))
      .limit(1);
    return (row as ImportBatchRow | undefined) ?? null;
  }
}
