import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewTenant, TenantRow, tenants } from '@/db/schema/tenants';

@Injectable()
export class TenantsRepository extends BaseRepository<
  typeof tenants,
  TenantRow,
  NewTenant,
  Partial<NewTenant>
> {
  constructor(db: DbService) {
    super(db.getDb(), tenants, 'tenants');
  }

  async findBySubdomain(subdomain: string): Promise<TenantRow | null> {
    const [row] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.subdomain, subdomain.toLowerCase()))
      .limit(1);
    return (row as TenantRow | undefined) ?? null;
  }

  async suspend(id: string, reason: string): Promise<void> {
    await this.db
      .update(tenants)
      .set({ status: 'suspended', suspendedAt: new Date(), suspendedReason: reason })
      .where(eq(tenants.id, id));
  }

  async reactivate(id: string): Promise<void> {
    await this.db
      .update(tenants)
      .set({ status: 'active', suspendedAt: null, suspendedReason: null })
      .where(eq(tenants.id, id));
  }
}
