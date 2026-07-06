import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';

import { DbService } from '@/db/db.service';
import { BaseRepository } from '@/db/repositories/base.repository';
import { LowStockRuleRow, NewLowStockRule, lowStockRules } from '@/db/schema/low-stock-rules';

/**
 * BE-27 — `low_stock_rules` data access.
 *
 * Resolution semantics live here so callers don't have to remember
 * "product before category". `findApplicableRule` returns the most
 * specific rule for a (productId, storeId) pair and falls back to a
 * category rule when one exists.
 */
@Injectable()
export class LowStockRulesRepository extends BaseRepository<
  typeof lowStockRules,
  LowStockRuleRow,
  NewLowStockRule,
  Partial<NewLowStockRule>
> {
  constructor(db: DbService) {
    super(db.getDb(), lowStockRules, 'low_stock_rules');
  }

  async findProductRule(productId: string, storeId: string): Promise<LowStockRuleRow | null> {
    const [row] = await this.db
      .select()
      .from(lowStockRules)
      .where(
        and(
          eq(lowStockRules.productId, productId),
          eq(lowStockRules.storeId, storeId),
          isNull(lowStockRules.deletedAt),
        ),
      )
      .limit(1);
    return (row as LowStockRuleRow | undefined) ?? null;
  }

  async findCategoryRule(category: string, storeId: string): Promise<LowStockRuleRow | null> {
    const [row] = await this.db
      .select()
      .from(lowStockRules)
      .where(
        and(
          eq(lowStockRules.category, category),
          eq(lowStockRules.storeId, storeId),
          isNull(lowStockRules.deletedAt),
        ),
      )
      .limit(1);
    return (row as LowStockRuleRow | undefined) ?? null;
  }

  /**
   * Most-specific resolution. The category lookup is best-effort: if
   * the caller doesn't pass `category` we skip it and rely on the
   * product-level rule alone.
   */
  async findApplicableRule(
    productId: string,
    storeId: string,
    category?: string | null,
  ): Promise<LowStockRuleRow | null> {
    const product = await this.findProductRule(productId, storeId);
    if (product) return product;
    if (category) return this.findCategoryRule(category, storeId);
    return null;
  }

  async listForStore(tenantId: string, storeId: string): Promise<LowStockRuleRow[]> {
    return (await this.db
      .select()
      .from(lowStockRules)
      .where(
        and(
          eq(lowStockRules.tenantId, tenantId),
          eq(lowStockRules.storeId, storeId),
          isNull(lowStockRules.deletedAt),
        ),
      )) as LowStockRuleRow[];
  }

  /**
   * Idempotent upsert keyed on (productId, storeId) or (category,
   * storeId). The two modes are mutually exclusive — exactly one of
   * `productId` or `category` must be set, enforced by the caller.
   */
  async upsert(input: NewLowStockRule): Promise<LowStockRuleRow> {
    if (input.productId) {
      const existing = await this.findProductRule(input.productId, input.storeId);
      if (existing) {
        return this.update(existing.id, {
          threshold: input.threshold,
          enabled: input.enabled,
          notes: input.notes,
          updatedBy: input.updatedBy ?? input.createdBy ?? null,
        });
      }
    } else if (input.category) {
      const existing = await this.findCategoryRule(input.category, input.storeId);
      if (existing) {
        return this.update(existing.id, {
          threshold: input.threshold,
          enabled: input.enabled,
          notes: input.notes,
          updatedBy: input.updatedBy ?? input.createdBy ?? null,
        });
      }
    }
    return this.create(input);
  }
}
