import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewStore, StoreRow, stores } from '@/db/schema/tenants';

@Injectable()
export class StoresRepository extends BaseRepository<
  typeof stores,
  StoreRow,
  NewStore,
  Partial<NewStore>
> {
  constructor(db: DbService) {
    super(db.getDb(), stores, 'stores');
  }

  async findByTenantAndId(tenantId: string, id: string): Promise<StoreRow | null> {
    const [row] = await this.db
      .select()
      .from(stores)
      .where(and(eq(stores.tenantId, tenantId), eq(stores.id, id)))
      .limit(1);
    return (row as StoreRow | undefined) ?? null;
  }

  async listForTenant(tenantId: string): Promise<StoreRow[]> {
    return (await this.db.select().from(stores).where(eq(stores.tenantId, tenantId))) as StoreRow[];
  }
}
