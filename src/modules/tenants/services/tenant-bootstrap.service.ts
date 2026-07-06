import { Injectable } from '@nestjs/common';

import { ConfigService } from '@/config/config.service';
import { DbService } from '@/db/db.service';
import { TenantRow, tenants } from '@/db/schema/tenants';
import { users } from '@/db/schema/users';
import { eq } from 'drizzle-orm';

import { TenantsRepository } from '../repositories/tenants.repository';

/**
 * Personal-tenant bootstrap (BE-09 v2 ADDENDUM, Req 1 + Req 26).
 *
 * BE-06 currently leaves `users.tenantId` null for new Consumer
 * signups because the personal tenant did not exist yet. This service
 * provisions one in a single transaction:
 *
 *   1. Create `tenants` row with `kind='personal', name='personal:<userId>'`.
 *   2. Patch the user's `tenantId` to point at the new row.
 *
 * BE-35 Business Activation reuses the same DbService transaction
 * helper to upgrade the user's role to `owner` and migrate their
 * personal-tenant data into a new business tenant — but that's owned
 * by the BE-35 phase.
 */
@Injectable()
export class TenantBootstrapService {
  constructor(
    private readonly db: DbService,
    private readonly tenants: TenantsRepository,
    private readonly _config: ConfigService,
  ) {}

  async createPersonalTenantForConsumer(userId: string, countryCode = 'IN'): Promise<TenantRow> {
    return this.db.transaction(async (tx) => {
      const [tenant] = await tx
        .insert(tenants)
        .values({
          name: `personal:${userId}`,
          kind: 'personal',
          status: 'active',
          country: countryCode,
        })
        .returning();
      await tx.update(users).set({ tenantId: tenant.id }).where(eq(users.id, userId));
      return tenant as TenantRow;
    });
  }

  async ensurePersonalTenant(userId: string, countryCode = 'IN'): Promise<TenantRow> {
    const [existing] = await this.db
      .getDb()
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (existing?.tenantId) {
      const tenantRow = await this.tenants.findById(existing.tenantId);
      if (tenantRow) return tenantRow;
    }
    return this.createPersonalTenantForConsumer(userId, countryCode);
  }
}
