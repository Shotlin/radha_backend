import { Injectable } from '@nestjs/common';

import { LoggerService } from '@/logging/logger.service';

import { HealthScoresRepository } from '../repositories/health-scores.repository';
import type {
  ComponentInput,
  HealthScorePersistedRow,
  HealthScoreSnapshot,
  HealthScoreTrendPoint,
  HealthScoreView,
  IComponentCalculator,
  OhsComponentName,
} from '../types/dashboard.types';

import { ComplianceCalculator } from './components/compliance.calculator';
import { ExpiryManagementCalculator } from './components/expiry-management.calculator';
import { InventoryAccuracyCalculator } from './components/inventory-accuracy.calculator';
import { TaskCompletionCalculator } from './components/task-completion.calculator';
import { TeamActivityCalculator } from './components/team-activity.calculator';
import { VendorQualityCalculator } from './components/vendor-quality.calculator';

/**
 * BE-30 v2 — Operational Health Score (OHS) service.
 *
 * Composes the six component calculators:
 *
 *   Compliance         25 %
 *   ExpiryManagement   20 %
 *   InventoryAccuracy  20 %
 *   TaskCompletion     15 %
 *   TeamActivity       10 %
 *   VendorQuality      10 %
 *
 * Each calculator returns a score in [0, 1]. The service multiplies
 * by the calculator's weight, sums to a single 0..1 number, and
 * scales to 0..100 with two-decimal precision.
 *
 * Algorithm version is stamped on every persisted row so historical
 * scores remain comparable when the formula evolves.
 */
@Injectable()
export class OperationalHealthScoreService {
  /**
   * Bumping this string is the sole way to introduce a new algorithm.
   * The cron writes one row per `(tenant, store, date, algorithm)`,
   * so old and new scores coexist on the trend without overwriting
   * each other.
   */
  static readonly ALGORITHM_VERSION = 'v1.2';

  /** ±10 day-over-day change fires the FCM alert (Req 29). */
  static readonly DELTA_ALERT_THRESHOLD = 10;

  constructor(
    private readonly compliance: ComplianceCalculator,
    private readonly expiry: ExpiryManagementCalculator,
    private readonly inventory: InventoryAccuracyCalculator,
    private readonly tasks: TaskCompletionCalculator,
    private readonly team: TeamActivityCalculator,
    private readonly vendor: VendorQualityCalculator,
    private readonly repo: HealthScoresRepository,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Public list of calculators in canonical order. Used by the
   * service itself, by tests, and by the cron when iterating.
   */
  get calculators(): IComponentCalculator[] {
    return [this.compliance, this.expiry, this.inventory, this.tasks, this.team, this.vendor];
  }

  /**
   * Computes — but does not persist — the OHS for one store. Returns
   * the snapshot so the caller can decide whether to write it
   * (the cron does, ad-hoc recompute does not).
   */
  async computeForStore(input: ComponentInput): Promise<HealthScoreSnapshot> {
    const calculators = this.calculators;
    const results = await Promise.all(calculators.map((c) => c.compute(input)));

    const breakdown = {} as Record<OhsComponentName, number>;
    const rawInputs = {} as Record<OhsComponentName, Record<string, unknown>>;

    let weighted = 0;
    for (let i = 0; i < calculators.length; i++) {
      const c = calculators[i];
      const r = results[i];
      const score = clamp01(r.rawScore);
      breakdown[c.name] = score;
      rawInputs[c.name] = r.rawInputs;
      weighted += c.weight * score;
    }

    const total = round2(clamp01(weighted) * 100);

    return {
      total,
      breakdown,
      rawInputs,
      algorithmVersion: OperationalHealthScoreService.ALGORITHM_VERSION,
    };
  }

  /**
   * Computes + persists the snapshot for a given date. Idempotent:
   * the unique index `(tenant, store, computed_for_date,
   * algorithm_version)` makes re-runs overwrite the row.
   */
  async computeAndPersist(
    tenantId: string,
    storeId: string,
    asOf: Date,
  ): Promise<HealthScoreSnapshot> {
    const snapshot = await this.computeForStore({ tenantId, storeId, asOf });

    await this.repo.upsertForDate({
      tenantId,
      storeId,
      computedForDate: asOf.toISOString().slice(0, 10),
      algorithmVersion: snapshot.algorithmVersion,
      total: snapshot.total,
      breakdown: snapshot.breakdown,
      rawInputs: snapshot.rawInputs,
    });

    this.logger.info('dashboard.ohs.persisted', {
      tenantId,
      storeId,
      date: asOf.toISOString().slice(0, 10),
      total: snapshot.total,
      algorithmVersion: snapshot.algorithmVersion,
    });

    return snapshot;
  }

  /** Reads the latest persisted row (or null when none exist). */
  async getLatest(tenantId: string, storeId: string): Promise<HealthScorePersistedRow | null> {
    return this.repo.findLatest(tenantId, storeId);
  }

  /** Reads the previous day's row for the same algorithm version. */
  async getPreviousDay(
    tenantId: string,
    storeId: string,
    beforeDate: string,
    algorithmVersion: string = OperationalHealthScoreService.ALGORITHM_VERSION,
  ): Promise<HealthScorePersistedRow | null> {
    return this.repo.findPreviousDay(tenantId, storeId, beforeDate, algorithmVersion);
  }

  /** Returns up to `days` daily trend points ordered oldest → newest. */
  async getTrend(tenantId: string, storeId: string, days = 30): Promise<HealthScoreTrendPoint[]> {
    return this.repo.findTrend(tenantId, storeId, days);
  }

  /** Convenience read used by the dashboard payload. */
  async getView(tenantId: string, storeId: string): Promise<HealthScoreView> {
    const [latest, trend30d] = await Promise.all([
      this.getLatest(tenantId, storeId),
      this.getTrend(tenantId, storeId, 30),
    ]);
    return {
      latest,
      trend30d,
      algorithmVersion: OperationalHealthScoreService.ALGORITHM_VERSION,
    };
  }

  /** Returns true when `|today - yesterday| ≥ DELTA_ALERT_THRESHOLD`. */
  static deltaCrosses(today: number, yesterday: number): boolean {
    return Math.abs(today - yesterday) >= OperationalHealthScoreService.DELTA_ALERT_THRESHOLD;
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
