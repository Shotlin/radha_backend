import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, ne, type SQL } from 'drizzle-orm';

import type { Transaction } from '@/db/connection';
import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { NewSupplierContact, SupplierContactRow, supplierContacts } from '@/db/schema/suppliers';

/**
 * BE-25 — `supplier_contacts` data access.
 *
 * Owns the "exactly one primary" invariant in coordination with the
 * partial unique index on `(supplier_id) WHERE is_primary = true`.
 * The repository exposes `unsetPrimaryForSupplier` for the service
 * to call before promoting a new contact, keeping the service free
 * of SQL.
 */
@Injectable()
export class SupplierContactsRepository extends BaseRepository<
  typeof supplierContacts,
  SupplierContactRow,
  NewSupplierContact,
  Partial<NewSupplierContact>
> {
  constructor(db: DbService) {
    super(db.getDb(), supplierContacts, 'supplier_contacts');
  }

  async listForSupplier(supplierId: string): Promise<SupplierContactRow[]> {
    return (await this.db
      .select()
      .from(supplierContacts)
      .where(and(eq(supplierContacts.supplierId, supplierId), isNull(supplierContacts.deletedAt)))
      .orderBy(asc(supplierContacts.name))) as SupplierContactRow[];
  }

  async findByIdInTenant(id: string, tenantId: string): Promise<SupplierContactRow | null> {
    const [row] = await this.db
      .select()
      .from(supplierContacts)
      .where(
        and(
          eq(supplierContacts.id, id),
          eq(supplierContacts.tenantId, tenantId),
          isNull(supplierContacts.deletedAt),
        ),
      )
      .limit(1);
    return (row as SupplierContactRow | undefined) ?? null;
  }

  /**
   * Demotes any other primary contact on this supplier so a fresh
   * promotion doesn't trip the partial unique index. Excluding
   * `excludeContactId` lets us no-op when the caller is re-saving an
   * already-primary record.
   */
  async unsetPrimaryForSupplier(
    supplierId: string,
    excludeContactId?: string,
    tx?: Transaction,
  ): Promise<void> {
    const scope = tx ?? this.db;
    const conditions: SQL[] = [
      eq(supplierContacts.supplierId, supplierId),
      eq(supplierContacts.isPrimary, true),
      isNull(supplierContacts.deletedAt),
    ];
    if (excludeContactId) {
      conditions.push(ne(supplierContacts.id, excludeContactId));
    }
    await scope
      .update(supplierContacts)
      .set({ isPrimary: false, updatedAt: new Date() })
      .where(and(...conditions));
  }

  async findPrimaryForSupplier(supplierId: string): Promise<SupplierContactRow | null> {
    const [row] = await this.db
      .select()
      .from(supplierContacts)
      .where(
        and(
          eq(supplierContacts.supplierId, supplierId),
          eq(supplierContacts.isPrimary, true),
          isNull(supplierContacts.deletedAt),
        ),
      )
      .limit(1);
    return (row as SupplierContactRow | undefined) ?? null;
  }

  async bulkCreate(rows: NewSupplierContact[], tx?: Transaction): Promise<SupplierContactRow[]> {
    if (rows.length === 0) return [];
    const scope = tx ?? this.db;
    const inserted = (await scope
      .insert(supplierContacts)
      .values(rows as never[])
      .returning()) as SupplierContactRow[];
    return inserted;
  }
}
