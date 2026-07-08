import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type {
  BarcodeLearningStatus,
  BarcodeLearningSubmissionRow,
} from '@/db/schema/barcode-learning';
import { CloudFrontService } from '@/integrations/aws/cloudfront/cloudfront.service';
import { LoggerService } from '@/logging/logger.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { HealthScoringService } from '@/modules/health-scoring/services/health-scoring.service';
import { AuditLogService } from '@/observability/audit-log.service';

import type { ApproveSubmissionDto, RejectSubmissionDto } from '../dto/moderate.dto';
import type { FlagProductDto } from '../dto/flag-product.dto';
import type { SubmitBarcodeDto } from '../dto/submit-barcode.dto';
import {
  PRODUCTS_CATALOG_PORT,
  ProductsCatalogPort,
} from '../ports/products-catalog.port';
import { FlagRepository } from '../repositories/flag.repository';
import { SubmissionRepository } from '../repositories/submission.repository';
import { FlagTrackerService, FlagTrackResult } from './flag-tracker.service';

/**
 * BE-56 — Community Barcode Learning service.
 *
 * Owns:
 *   - Consumer submission (`submit`)
 *     • Enforces `MAX_SUBMISSIONS_PER_DAY` per user (in-memory
 *       fallback; future BE-46 v2 hookup will swap in Redis).
 *     • Always inserts a fresh row — multiple users may submit the
 *       same EAN. The moderator consolidates on approve.
 *
 *   - Moderator queue (`listQueue`)
 *     • Filters by `status` (`pending` by default, `flagged` for
 *       re-moderation cases).
 *
 *   - Approval (`approve`)
 *     • Pushes the (optionally edited) data through the
 *       `ProductsCatalogPort` — the global `Product_Catalog` upsert
 *       happens here, behind the port boundary.
 *     • Sets `status='approved'`, `moderated_at`, `moderated_by`.
 *
 *   - Rejection (`reject`)
 *     • Sets `status='rejected'`, `moderated_at`, `moderation_notes`.
 *     • Does NOT touch the catalog.
 *
 *   - Flag (`flag`)
 *     • Inserts via the unique constraint so duplicate user flags
 *       are silent no-ops.
 *     • Delegates threshold evaluation to `FlagTrackerService` so
 *       the cross-cutting policy lives in one place.
 *
 * Every state-changing path writes an audit log entry. PII fields
 * (brand, name, category) are bounded by the DTO; we log only the
 * EAN + ids.
 */

/** BE-56 spec: 10 submissions / user / day. */
export const MAX_SUBMISSIONS_PER_DAY = 10;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * BE-56 v2 — nutrition panel values as plain numbers. Used on
 * `SubmissionDto` (API-facing) and internally when merging a
 * submission's stored nutrition with a moderator's approval-time
 * overrides. Decimal-string conversion for the DB happens at the
 * repository/adapter boundary (`toDecimalPatch` below,
 * `real-products-catalog.adapter.ts`'s `toDecimalRow`).
 */
export interface NutritionValues {
  servingSize?: number;
  servingUnit?: string;
  calories?: number;
  protein?: number;
  carbohydrates?: number;
  sugars?: number;
  fat?: number;
  saturatedFat?: number;
  transFat?: number;
  fiber?: number;
  sodium?: number;
}

export interface SubmissionDto {
  id: string;
  submitterUserId: string;
  ean: string;
  brand: string | null;
  name: string | null;
  category: string | null;
  /** BE-56 v3 — the label's INGREDIENTS list. */
  ingredients: string | null;
  s3ObjectKeys: string[];
  nutrition: NutritionValues | null;
  status: BarcodeLearningStatus;
  submittedAt: string;
  moderatedAt: string | null;
  moderatedBy: string | null;
  moderationNotes: string | null;
}

export interface QueueResultDto {
  data: SubmissionDto[];
  total: number;
  limit: number;
  offset: number;
}

export interface FlagResultDto {
  ean: string;
  uniqueFlagCount: number;
  thresholdCrossed: boolean;
  flippedSubmissionId: string | null;
  duplicate: boolean;
}

export interface ApproveResultDto {
  submission: SubmissionDto;
  productId: string;
  catalogCreated: boolean;
}

/** BE-56 v2 — submission + CDN-resolved image URLs, for the admin detail view. */
export interface SubmissionDetailDto extends SubmissionDto {
  imageUrls: string[];
}

@Injectable()
export class BarcodeLearningService {
  constructor(
    private readonly submissions: SubmissionRepository,
    private readonly flags: FlagRepository,
    private readonly flagTracker: FlagTrackerService,
    @Inject(PRODUCTS_CATALOG_PORT)
    private readonly catalog: ProductsCatalogPort,
    private readonly logger: LoggerService,
    private readonly audit: AuditLogService,
    private readonly cdn: CloudFrontService,
    private readonly notifications: NotificationsService,
    private readonly healthScoring: HealthScoringService,
  ) {}

  /* ─────────────────── Consumer: submit ─────────────────── */

  /**
   * Insert a pending submission. Enforces the daily rate limit by
   * counting rows in the last 24 hours; the BE-56 spec calls for a
   * 10-per-day cap and notes that a Redis-backed counter is fine to
   * swap in later.
   */
  async submit(userId: string, dto: SubmitBarcodeDto): Promise<SubmissionDto> {
    if (!userId) {
      throw new BadRequestException('userId is required');
    }

    const since = new Date(Date.now() - ONE_DAY_MS);
    const todayCount = await this.submissions.countByUserSince(userId, since);
    if (todayCount >= MAX_SUBMISSIONS_PER_DAY) {
      throw new ConflictException(
        `Daily submission limit reached (max ${MAX_SUBMISSIONS_PER_DAY} per user per day)`,
      );
    }

    const row = await this.submissions.create({
      submitterUserId: userId,
      ean: dto.ean,
      brand: dto.brand ?? null,
      name: dto.name ?? null,
      category: dto.category ?? null,
      ingredients: dto.ingredients ?? null,
      s3ObjectKeys: dto.s3ObjectKeys ?? null,
      ...toDecimalPatch(dto.nutrition),
    });

    this.logger.info('barcode_learning.submitted', {
      submissionId: row.id,
      ean: row.ean,
      userId,
    });

    void this.audit.logAction({
      action: 'CREATE',
      resourceType: 'barcode_learning_submission',
      resourceId: row.id,
      tenantId: '',
      userId,
      success: true,
      metadata: { ean: row.ean, hasImages: (dto.s3ObjectKeys?.length ?? 0) > 0 },
    });

    return this.toDto(row);
  }

  /* ─────────────────── Moderator: queue ─────────────────── */

  /**
   * Return submissions awaiting a moderator decision. `pending` is
   * the default; `flagged` re-surfaces previously approved entries
   * that the community has called into question.
   */
  async listQueue(filters: {
    status: BarcodeLearningStatus;
    limit: number;
    offset: number;
  }): Promise<QueueResultDto> {
    const [rows, total] = await Promise.all([
      this.submissions.listByStatus(filters.status, {
        limit: filters.limit,
        offset: filters.offset,
      }),
      this.submissions.countByStatus(filters.status),
    ]);
    return {
      data: rows.map((r) => this.toDto(r)),
      total,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  /**
   * BE-56 v2 — full submission detail for the admin review dialog:
   * every field from the queue listing plus CDN-resolved URLs for
   * each attached image, so the moderator can actually see the
   * photo(s) before approving.
   */
  async getSubmission(id: string): Promise<SubmissionDetailDto> {
    const row = await this.requireSubmission(id);
    const dto = this.toDto(row);
    return {
      ...dto,
      imageUrls: dto.s3ObjectKeys.map((key) => this.cdn.getCdnUrl(key)),
    };
  }

  /* ─────────────────── Moderator: approve ─────────────────── */

  /**
   * Approve a submission and push its data into `Product_Catalog`
   * via the port. Refuses to re-approve a row that is already
   * approved/rejected (idempotency boundary lives at the controller
   * + service contract — repeated clicks return a clean conflict
   * rather than silently corrupting the timeline).
   */
  async approve(
    submissionId: string,
    moderatorId: string,
    dto: ApproveSubmissionDto,
  ): Promise<ApproveResultDto> {
    const existing = await this.requireSubmission(submissionId);
    if (existing.status === 'approved') {
      throw new ConflictException('Submission is already approved');
    }
    if (existing.status === 'rejected') {
      throw new ConflictException('Submission was rejected — submit a new one to revisit');
    }

    const merged = {
      ean: existing.ean,
      brand: dto.brand ?? existing.brand,
      name: dto.name ?? existing.name,
      category: dto.category ?? existing.category,
      ingredients: dto.ingredients ?? existing.ingredients,
      s3ObjectKeys: existing.s3ObjectKeys,
      nutrition: { ...rowToNutrition(existing), ...dto.nutrition },
    };

    if (!merged.name) {
      throw new BadRequestException(
        'Product name is required before approval — fill it in via `name` in the approve body',
      );
    }

    // The first submitted photo becomes the catalog product image so
    // every future scanner of this EAN sees what the submitter saw.
    const firstKey = existing.s3ObjectKeys?.[0];
    const imageUrl = firstKey ? this.cdn.getCdnUrl(firstKey) : null;

    const catalogResult = await this.catalog.upsertGlobal({
      ean: merged.ean,
      brand: merged.brand,
      name: merged.name,
      category: merged.category,
      ingredients: merged.ingredients,
      imageUrl,
      s3ObjectKeys: merged.s3ObjectKeys,
      nutrition: hasAnyNutrition(merged.nutrition) ? merged.nutrition : null,
      source: 'community',
      submitterUserId: existing.submitterUserId,
      approvedBy: moderatorId,
    });

    const updated = await this.submissions.updateStatus(submissionId, {
      status: 'approved',
      moderatedAt: new Date(),
      moderatedBy: moderatorId,
      moderationNotes: dto.notes ?? null,
    });
    if (!updated) {
      throw new NotFoundException('Submission not found');
    }

    this.logger.info('barcode_learning.approved', {
      submissionId,
      ean: existing.ean,
      moderatorId,
      productId: catalogResult.productId,
      catalogCreated: catalogResult.created,
    });

    void this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'barcode_learning_submission',
      resourceId: submissionId,
      tenantId: '',
      userId: moderatorId,
      success: true,
      metadata: {
        outcome: 'approved',
        ean: existing.ean,
        productId: catalogResult.productId,
        catalogCreated: catalogResult.created,
      },
    });

    // Best-effort: a scoring or notification failure must never fail the
    // approval transaction itself, which has already committed above.
    void this.healthScoring.scoreProduct(catalogResult.productId).catch((err) => {
      this.logger.warn('barcode_learning.approve.score_failed', {
        productId: catalogResult.productId,
        error: { name: (err as Error).name, message: (err as Error).message },
      });
    });
    void this.notifications
      .send({
        tenantId: '',
        userId: existing.submitterUserId,
        channels: ['push', 'in-app'],
        category: 'system',
        subject: 'Your product submission was approved',
        body: `${merged.name} is now live in the RADHA catalog. Thanks for contributing!`,
        data: { submissionId, ean: existing.ean, productId: catalogResult.productId },
        relatedResourceType: 'product',
        relatedResourceId: catalogResult.productId,
      })
      .catch((err) => {
        this.logger.warn('barcode_learning.approve.notify_failed', {
          submissionId,
          error: { name: (err as Error).name, message: (err as Error).message },
        });
      });

    return {
      submission: this.toDto(updated),
      productId: catalogResult.productId,
      catalogCreated: catalogResult.created,
    };
  }

  /* ─────────────────── Moderator: reject ─────────────────── */

  /**
   * Reject a submission with a mandatory reason. Does NOT call the
   * catalog — rejected entries never become public.
   */
  async reject(
    submissionId: string,
    moderatorId: string,
    dto: RejectSubmissionDto,
  ): Promise<SubmissionDto> {
    const existing = await this.requireSubmission(submissionId);
    if (existing.status === 'approved') {
      throw new ConflictException('Submission is already approved — cannot reject');
    }
    if (existing.status === 'rejected') {
      throw new ConflictException('Submission is already rejected');
    }

    const updated = await this.submissions.updateStatus(submissionId, {
      status: 'rejected',
      moderatedAt: new Date(),
      moderatedBy: moderatorId,
      moderationNotes: dto.reason,
    });
    if (!updated) {
      throw new NotFoundException('Submission not found');
    }

    this.logger.info('barcode_learning.rejected', {
      submissionId,
      ean: existing.ean,
      moderatorId,
    });

    void this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'barcode_learning_submission',
      resourceId: submissionId,
      tenantId: '',
      userId: moderatorId,
      success: true,
      metadata: { outcome: 'rejected', ean: existing.ean },
    });

    void this.notifications
      .send({
        tenantId: '',
        userId: existing.submitterUserId,
        channels: ['in-app'],
        category: 'system',
        subject: 'Your product submission was not approved',
        body: `Your submission for ${existing.ean} wasn't approved: ${dto.reason}`,
        data: { submissionId, ean: existing.ean, reason: dto.reason },
        relatedResourceType: 'barcode_learning_submission',
        relatedResourceId: submissionId,
      })
      .catch((err) => {
        this.logger.warn('barcode_learning.reject.notify_failed', {
          submissionId,
          error: { name: (err as Error).name, message: (err as Error).message },
        });
      });

    return this.toDto(updated);
  }

  /* ─────────────────── Consumer: flag ─────────────────── */

  /**
   * Record a consumer flag against an EAN. The unique
   * `(product_ean, flagger_user_id)` constraint keeps a single user
   * from inflating the threshold; duplicates are silent no-ops
   * (`duplicate: true` in the response).
   *
   * After every successful insert we evaluate the threshold via
   * `FlagTrackerService`. The flip happens inside the tracker so
   * the policy lives in one place.
   */
  async flag(userId: string, ean: string, dto: FlagProductDto): Promise<FlagResultDto> {
    if (!userId) {
      throw new BadRequestException('userId is required');
    }

    const inserted = await this.flags.create({
      productEan: ean,
      flaggerUserId: userId,
      reason: dto.reason ?? null,
    });
    const duplicate = inserted === null;

    let trackResult: FlagTrackResult;
    if (duplicate) {
      // Same user, same EAN — count is unchanged. Still surface the
      // current count so the client can render a "you already
      // flagged this" affordance.
      const uniqueFlagCount = await this.flags.countUniqueByEan(ean);
      trackResult = {
        ean,
        uniqueFlagCount,
        thresholdCrossed: false,
        flippedSubmissionId: null,
      };
    } else {
      trackResult = await this.flagTracker.evaluate(ean);
    }

    this.logger.info('barcode_learning.flagged', {
      ean,
      userId,
      duplicate,
      uniqueFlagCount: trackResult.uniqueFlagCount,
      thresholdCrossed: trackResult.thresholdCrossed,
    });

    if (!duplicate) {
      void this.audit.logAction({
        action: 'CREATE',
        resourceType: 'barcode_learning_flag',
        resourceId: ean,
        tenantId: '',
        userId,
        success: true,
        metadata: {
          ean,
          uniqueFlagCount: trackResult.uniqueFlagCount,
          thresholdCrossed: trackResult.thresholdCrossed,
        },
      });
    }

    return {
      ean: trackResult.ean,
      uniqueFlagCount: trackResult.uniqueFlagCount,
      thresholdCrossed: trackResult.thresholdCrossed,
      flippedSubmissionId: trackResult.flippedSubmissionId,
      duplicate,
    };
  }

  /* ─────────────────── Internal helpers ─────────────────── */

  private async requireSubmission(id: string): Promise<BarcodeLearningSubmissionRow> {
    const row = await this.submissions.findById(id);
    if (!row) {
      throw new NotFoundException('Submission not found');
    }
    return row;
  }

  private toDto(row: BarcodeLearningSubmissionRow): SubmissionDto {
    const nutrition = rowToNutrition(row);
    return {
      id: row.id,
      submitterUserId: row.submitterUserId,
      ean: row.ean,
      brand: row.brand ?? null,
      name: row.name ?? null,
      category: row.category ?? null,
      ingredients: row.ingredients ?? null,
      s3ObjectKeys: row.s3ObjectKeys ?? [],
      nutrition: hasAnyNutrition(nutrition) ? nutrition : null,
      status: row.status as BarcodeLearningStatus,
      submittedAt: row.submittedAt.toISOString(),
      moderatedAt: row.moderatedAt ? row.moderatedAt.toISOString() : null,
      moderatedBy: row.moderatedBy ?? null,
      moderationNotes: row.moderationNotes ?? null,
    };
  }
}

/**
 * BE-56 v2 — decimal-string helpers for the nutrition columns added
 * in migration `0033`. Mirrors `nutritionToRow`'s number↔string
 * convention in `products.service.ts` so the same values round-trip
 * identically whether they pass through the manual product-create
 * path or this one.
 */
function toDecimalPatch(n?: NutritionValues | null) {
  if (!n) return {};
  const dec = (v?: number) => (v === undefined ? undefined : v.toString());
  return {
    servingSize: dec(n.servingSize),
    servingUnit: n.servingUnit,
    calories: dec(n.calories),
    protein: dec(n.protein),
    carbohydrates: dec(n.carbohydrates),
    sugars: dec(n.sugars),
    fat: dec(n.fat),
    saturatedFat: dec(n.saturatedFat),
    transFat: dec(n.transFat),
    fiber: dec(n.fiber),
    sodium: dec(n.sodium),
  };
}

function rowToNutrition(row: BarcodeLearningSubmissionRow): NutritionValues {
  const num = (v: string | null | undefined) => (v === null || v === undefined ? undefined : Number(v));
  return {
    servingSize: num(row.servingSize),
    servingUnit: row.servingUnit ?? undefined,
    calories: num(row.calories),
    protein: num(row.protein),
    carbohydrates: num(row.carbohydrates),
    sugars: num(row.sugars),
    fat: num(row.fat),
    saturatedFat: num(row.saturatedFat),
    transFat: num(row.transFat),
    fiber: num(row.fiber),
    sodium: num(row.sodium),
  };
}

function hasAnyNutrition(n: NutritionValues): boolean {
  return Object.values(n).some((v) => v !== undefined);
}
