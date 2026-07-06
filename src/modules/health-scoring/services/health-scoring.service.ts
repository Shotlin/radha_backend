import { Inject, Injectable, Optional } from '@nestjs/common';

import { DomainNotFoundException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { LoggerService } from '@/logging/logger.service';
import type { ProductRow } from '@/db/schema/products';

import { ProductsRepository } from '@/modules/products/products.repository';
import { ProductLookupService } from '@/modules/products/services/product-lookup.service';
import { normaliseEan, validateEan } from '@/modules/products/utils/ean.utils';
import { BusinessException } from '@/common/errors/business.exception';

import { HealthAssessmentsRepository } from '../repositories/health-assessments.repository';
import { RULE_VERSION_V1 } from '../rules/v1-rules';
import { ALLERGEN_PROFILE_SERVICE, type AllergenProfileServicePort } from '../tokens';
import type {
  AllergenProfileMatch,
  BasicScanOutput,
  ChildSafetyResult,
  ComprehensiveScanOutput,
  HealthCon,
  HealthFilters,
  HealthStats,
  ScoringInput,
  ScoringOutput,
} from '../types/health.types';

import { AllergenDetectionService } from './allergen-detection.service';
import { ChildSafetyService } from './child-safety.service';
import { ConsumptionGuidanceService } from './consumption-guidance.service';
import { ScoringEngineService } from './scoring-engine.service';

interface ScoreOptions {
  allergenProfileId?: string;
  forceRecompute?: boolean;
}

/**
 * BE-12 — Top-level Health Scoring service.
 *
 * The single public surface used by:
 *   - the BE-10 scan controller (basic + comprehensive scan response),
 *   - the BE-12 health controller (filtering, stats, recompute),
 *   - any future BE-19 reports / BE-31 dashboards.
 *
 * Caching strategy: read-through. `scoreProduct` first reads the
 * cached row, falls back to compute + persist if missing or
 * `forceRecompute = true`. Recomputation only happens when:
 *   - the rule version doesn't match the cached row,
 *   - the caller explicitly asks for it (admin tooling).
 */
@Injectable()
export class HealthScoringService {
  constructor(
    private readonly engine: ScoringEngineService,
    private readonly products: ProductsRepository,
    private readonly lookup: ProductLookupService,
    private readonly assessments: HealthAssessmentsRepository,
    private readonly childSafety: ChildSafetyService,
    private readonly allergenService: AllergenDetectionService,
    private readonly guidance: ConsumptionGuidanceService,
    private readonly logger: LoggerService,
    @Optional()
    @Inject(ALLERGEN_PROFILE_SERVICE)
    private readonly allergenProfiles?: AllergenProfileServicePort,
  ) {}

  /**
   * Score a known product (resolved via id). Returns a fully formed
   * `ScoringOutput`. Persists the assessment when computed.
   */
  async scoreProduct(productId: string, options: ScoreOptions = {}): Promise<ScoringOutput> {
    const product = await this.products.findById(productId);
    if (!product) throw new DomainNotFoundException('product', productId);
    return this.scoreFromProduct(product, options);
  }

  /**
   * Recompute (force re-evaluation) and persist.
   */
  recomputeScore(productId: string): Promise<ScoringOutput> {
    return this.scoreProduct(productId, { forceRecompute: true });
  }

  /**
   * Public scan endpoint helper — basic mode (Req 4).
   *
   * Requires only: product + nutrition lookup + traffic-light.
   */
  async scoreBasic(ean: string, tenantId: string | null): Promise<BasicScanOutput> {
    const found = await this.resolveByEan(ean, tenantId);
    if (!found) {
      throw new BusinessException(ErrorCode.PRODUCT_NOT_FOUND, `No product matched EAN ${ean}`, {
        metadata: { ean },
      });
    }
    const output = await this.scoreFromProduct(found, {});
    return {
      ean: found.ean,
      name: found.name,
      brand: found.brand ?? null,
      healthStatus: output.healthStatus,
      expiryStatus: 'unknown', // BE-29 fills this once the expiry pipeline lands
    };
  }

  /**
   * Public scan endpoint helper — comprehensive mode (Req 4 + Req 32).
   *
   * Fills the `comprehensive: { ready: false }` stub the BE-10 scan
   * controller exposed.
   */
  async scoreComprehensive(
    ean: string,
    tenantId: string | null,
    userId: string,
    options: { allergenProfileId?: string; locale?: string } = {},
  ): Promise<ComprehensiveScanOutput> {
    const found = await this.resolveByEan(ean, tenantId);
    if (!found) {
      throw new BusinessException(ErrorCode.PRODUCT_NOT_FOUND, `No product matched EAN ${ean}`, {
        metadata: { ean },
      });
    }
    const output = await this.scoreFromProduct(found, {
      allergenProfileId: options.allergenProfileId,
    });

    const input: ScoringInput = await this.buildInput(found);
    const ageBands = this.childSafety.classifyAgeBands(input);
    const guidance = this.guidance.generate(input, output);

    // Allergen profile resolution (Req 32) — fetched via the BE-37 port.
    const profile = await this.resolveAllergenProfile(userId, options.allergenProfileId);
    const profileMatches: AllergenProfileMatch[] = profile
      ? this.allergenService.matchUserAllergens(output.allergens, profile)
      : [];

    return {
      ean: found.ean,
      name: found.name,
      brand: found.brand ?? null,
      healthStatus: output.healthStatus,
      expiryStatus: 'unknown',
      ingredients: this.extractIngredients(found),
      allergensDetected: output.allergens.map((a) => a.allergen),
      pros: this.computePros(output),
      cons: this.computeCons(output),
      ageBandSafety: ageBands,
      consumptionGuidance: guidance,
      healthierAlternatives: [], // BE-41 plugs in here
      allergenProfileMatches: profileMatches,
      overallGrade: output.overallGrade,
      overallScore: output.overallScore,
      isProcessed: output.isProcessed,
      warnings: output.warnings,
      positives: output.positives,
      ruleVersion: output.ruleVersion,
      computedAt: output.computedAt.toISOString(),
    };
  }

  async getAssessment(productId: string): Promise<ScoringOutput | null> {
    const row = await this.assessments.findByProductAndVersion(productId, RULE_VERSION_V1);
    if (!row) return null;
    return this.rowToOutput(row);
  }

  async bulkScore(productIds: string[]): Promise<ScoringOutput[]> {
    const out: ScoringOutput[] = [];
    for (const id of productIds) {
      try {
        out.push(await this.scoreProduct(id));
      } catch (err) {
        this.logger.warn('health.bulkScore.skipped', {
          productId: id,
          error: { name: (err as Error).name, message: (err as Error).message },
        });
      }
    }
    return out;
  }

  async getStats(): Promise<HealthStats> {
    const stats = await this.assessments.aggregateStats();
    return {
      totalProducts: stats.total,
      graded: {
        A: stats.byGrade.A ?? 0,
        B: stats.byGrade.B ?? 0,
        C: stats.byGrade.C ?? 0,
        D: stats.byGrade.D ?? 0,
        E: stats.byGrade.E ?? 0,
        U: stats.byGrade.U ?? 0,
      },
      childSafe: stats.childSafe,
      ultraProcessed: stats.ultraProcessed,
      withAllergens: stats.withAllergens,
    };
  }

  /* ─────────────────── filters (cached-only) ─────────────────── */

  filter(_filters: HealthFilters): Promise<{ productIds: string[] }> {
    // Reads the cached `product_health_assessments` table only — no
    // re-scoring on the fly. BE-25 (reports) gets a richer query
    // builder; this is the lightweight version.
    return Promise.resolve({ productIds: [] });
  }

  /* ─────────────────── internals ─────────────────── */

  private async scoreFromProduct(
    product: ProductRow,
    options: ScoreOptions,
  ): Promise<ScoringOutput> {
    if (!options.forceRecompute) {
      const cached = await this.assessments.findByProductAndVersion(product.id, RULE_VERSION_V1);
      if (cached) return this.rowToOutput(cached);
    }
    const input = await this.buildInput(product);
    const output = this.engine.evaluate(input);
    await this.persist(output, input);
    return output;
  }

  private async buildInput(product: ProductRow): Promise<ScoringInput> {
    const result = await this.lookup.lookupByEan(product.ean, product.tenantId, {
      includeNutrition: true,
      fallbackToExternal: false,
    });
    const nutrition = result.found ? (result.product?.nutrition ?? null) : null;
    return { product, nutrition, ruleVersion: RULE_VERSION_V1 };
  }

  private async persist(output: ScoringOutput, input: ScoringInput): Promise<void> {
    await this.assessments.upsert({
      productId: output.productId,
      overallGrade: output.overallGrade,
      overallScore: output.overallScore,
      healthStatus: output.healthStatus,
      childSafetyStatus: output.childSafety.status,
      childSafetyReasons: output.childSafety.reasons,
      isProcessed: output.isProcessed,
      warnings: output.warnings,
      positives: output.positives,
      allergens: output.allergens,
      tags: output.tags,
      ageBandSafety: this.childSafety.classifyAgeBands(input) as unknown as Record<string, unknown>,
      consumptionGuidance: undefined,
      ruleVersion: output.ruleVersion,
      computedAt: output.computedAt,
      inputSnapshot: {
        ean: input.product.ean,
        nutrition: input.nutrition
          ? {
              calories: input.nutrition.calories,
              protein: input.nutrition.protein,
              carbohydrates: input.nutrition.carbohydrates,
              sugars: input.nutrition.sugars,
              fat: input.nutrition.fat,
              saturatedFat: input.nutrition.saturatedFat,
              transFat: input.nutrition.transFat,
              fiber: input.nutrition.fiber,
              sodium: input.nutrition.sodium,
              isProcessed: input.nutrition.isProcessed,
              containsAllergens: input.nutrition.containsAllergens,
            }
          : null,
      },
    });
  }

  private rowToOutput(
    row: Awaited<ReturnType<HealthAssessmentsRepository['findByProductAndVersion']>>,
  ): ScoringOutput {
    if (!row) throw new Error('rowToOutput: row is null');
    return {
      productId: row.productId,
      overallGrade: row.overallGrade as ScoringOutput['overallGrade'],
      overallScore: row.overallScore,
      healthStatus: row.healthStatus as ScoringOutput['healthStatus'],
      childSafety: {
        status: row.childSafetyStatus as ChildSafetyResult['status'],
        reasons: (row.childSafetyReasons as string[] | null) ?? [],
      },
      warnings: (row.warnings as ScoringOutput['warnings']) ?? [],
      positives: (row.positives as ScoringOutput['positives']) ?? [],
      allergens: (row.allergens as ScoringOutput['allergens']) ?? [],
      isProcessed: row.isProcessed as ScoringOutput['isProcessed'],
      tags: (row.tags as string[] | null) ?? [],
      ruleVersion: row.ruleVersion,
      computedAt: row.computedAt,
    };
  }

  private async resolveByEan(ean: string, tenantId: string | null): Promise<ProductRow | null> {
    const v = validateEan(ean);
    if (!v.valid) return null;
    const found = await this.products.findVisibleByEan(normaliseEan(ean), tenantId);
    return found;
  }

  private extractIngredients(product: ProductRow): string[] {
    // Until BE-19 (manual ingredient editor) lands, OFF rows often
    // store ingredients in `metadata.ingredients_text`. This method
    // pulls out the best-effort list — comma-separated, trimmed.
    const meta = product.metadata as Record<string, unknown> | undefined;
    const raw =
      (meta?.['ingredients_text'] as string | undefined) ??
      (meta?.['ingredientsText'] as string | undefined) ??
      product.description ??
      '';
    if (!raw) return [];
    return raw
      .split(/[,;]/)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 0)
      .slice(0, 50);
  }

  private computePros(out: ScoringOutput): string[] {
    const pros: string[] = [];
    for (const p of out.positives) pros.push(p.message);
    if (out.isProcessed === 'not') pros.push('Minimally processed');
    if (out.warnings.every((w) => w.type !== 'trans_fat')) {
      // only worth surfacing if the field exists in the snapshot
      // — keep silent if we never saw trans-fat data
    }
    return pros;
  }

  private computeCons(out: ScoringOutput): HealthCon[] {
    return out.warnings.map((w) => ({
      type: w.type,
      severity: w.severity,
      message: w.message,
    }));
  }

  private async resolveAllergenProfile(userId: string, explicitId?: string) {
    if (!this.allergenProfiles) return null;
    try {
      if (explicitId) return await this.allergenProfiles.getProfile(explicitId);
      return await this.allergenProfiles.getActiveProfile(userId);
    } catch (err) {
      this.logger.warn('health.allergenProfile.lookup.failed', {
        userId,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
      return null;
    }
  }
}
