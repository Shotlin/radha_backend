import { Inject, Injectable } from '@nestjs/common';

import { RequestContextService } from '@/common/context/request-context.service';
import { DomainNotFoundException } from '@/common/errors/business.exception';
import { LoggerService } from '@/logging/logger.service';
import { StoresRepository } from '@/modules/stores/repositories/stores.repository';

import type {
  ActivityFeed,
  ClientDashboard,
  DashboardAlerts,
  DashboardKpis,
  DashboardOptions,
  DashboardSubscription,
  DateRange,
  HealthScoreView,
  IClientDashboardService,
  MultiStoreSummary,
  QuickAction,
  TeamStats,
  TrendData,
} from '../types/dashboard.types';
import {
  SUBSCRIPTIONS_SERVICE_TOKEN,
  type ISubscriptionsService,
  type SubscriptionStatus,
} from '../types/integration.tokens';

import { AlertsSummaryService } from './alerts-summary.service';
import { DashboardCacheService } from './dashboard-cache.service';
import { KpiService } from './kpi.service';
import { OperationalHealthScoreService } from './operational-health-score.service';
import { QuickActionService } from './quick-action.service';
import { TeamPerformanceService } from './team-performance.service';
import { TrendsService } from './trends.service';

const STORE_RESOURCE = 'store';

/**
 * BE-30 — `ClientDashboardService` (façade).
 *
 * The mobile app calls `getDashboard(storeId)` once per pull-to-refresh
 * and gets every section in one payload. Sub-services execute in
 * parallel so the wall-clock cost approaches the slowest of the six
 * queries. Per-section endpoints (`/dashboard/kpis`, `/dashboard/alerts`,
 * etc.) hit the same sub-services without going through the cache, so
 * partial refreshes always see fresh data.
 *
 * Tenant + store scoping flow:
 *   - the controller's `RolesGuard` + `StoreScopeGuard` already
 *     verified that the user has access to `storeId` and that
 *     `storeId` is in the user's tenant.
 *   - `StoresRepository.findByTenantAndId` is the second line of
 *     defence — a 404 is thrown when the store doesn't exist or
 *     belongs to another tenant. Drizzle's prepared statement
 *     binds `tenantId` so even if the guard is bypassed in a
 *     future refactor, the query can't return another tenant's
 *     row.
 *
 * Caching:
 *   - one cache entry per `(userId, storeId)` so quick-actions
 *     that depend on user-specific subscription state don't leak
 *     across users.
 *   - 5-minute TTL — short enough to feel real-time, long enough
 *     to cut DB load by ~90% on a single user opening the app
 *     repeatedly.
 *   - invalidation on writes: see `DashboardCacheService.
 *     invalidateStore` and the orchestrator's hookup notes.
 */
@Injectable()
export class ClientDashboardService implements IClientDashboardService {
  constructor(
    private readonly kpis: KpiService,
    private readonly alerts: AlertsSummaryService,
    private readonly quickActions: QuickActionService,
    private readonly trends: TrendsService,
    private readonly team: TeamPerformanceService,
    private readonly cache: DashboardCacheService,
    private readonly storesRepo: StoresRepository,
    private readonly context: RequestContextService,
    private readonly logger: LoggerService,
    private readonly ohs: OperationalHealthScoreService,
    @Inject(SUBSCRIPTIONS_SERVICE_TOKEN)
    private readonly subscriptions: ISubscriptionsService,
  ) {}

  async getDashboard(storeId: string, options: DashboardOptions = {}): Promise<ClientDashboard> {
    const tenantId = this.requireTenantId();
    const userId = this.context.getUserId() ?? 'anon';

    const store = await this.storesRepo.findByTenantAndId(tenantId, storeId);
    if (!store) throw new DomainNotFoundException(STORE_RESOURCE, storeId);

    const cacheKey = `user:${userId}:${storeId}`;
    const cached = await this.cache.get<ClientDashboard>(cacheKey);
    if (cached) {
      // Re-hydrate Date columns deserialised as strings in JSON.
      this.logger.debug('dashboard.cache.hit', { storeId, userId });
      return this.rehydrate(cached);
    }

    const dateRange = options.dateRange ?? defaultDateRange();

    const [kpis, alerts, quickActions, trends, team, recentActivity, subscription, healthScore] =
      await Promise.all([
        this.kpis.getKpis(storeId, dateRange),
        this.alerts.getAlerts(storeId),
        this.quickActions.getQuickActions(storeId, userId),
        this.trends.getTrends(storeId, dateRange),
        this.team.getTeamStats(storeId, dateRange),
        this.getRecentActivity(storeId, 20),
        this.getSubscriptionStatus(tenantId).catch(() => fallbackSubscription()),
        this.ohs.getView(tenantId, storeId).catch(() => emptyHealthScoreView()),
      ]);

    const dashboard: ClientDashboard = {
      storeId,
      storeName: store.name,
      generatedAt: new Date(),
      kpis,
      alerts,
      quickActions,
      trends,
      team,
      recentActivity,
      subscriptionStatus: subscription,
      healthScore,
    };

    await this.cache.set(cacheKey, dashboard, DashboardCacheService.DEFAULT_TTL_SECONDS);
    return dashboard;
  }

  async getKpis(storeId: string, dateRange: DateRange): Promise<DashboardKpis> {
    await this.assertStoreInTenant(storeId);
    return this.kpis.getKpis(storeId, dateRange);
  }

  async getAlerts(storeId: string): Promise<DashboardAlerts> {
    await this.assertStoreInTenant(storeId);
    return this.alerts.getAlerts(storeId);
  }

  async getQuickActions(storeId: string, userId: string): Promise<QuickAction[]> {
    await this.assertStoreInTenant(storeId);
    return this.quickActions.getQuickActions(storeId, userId);
  }

  async getTrends(storeId: string, dateRange: DateRange): Promise<TrendData> {
    await this.assertStoreInTenant(storeId);
    return this.trends.getTrends(storeId, dateRange);
  }

  async getTeamPerformance(storeId: string, dateRange: DateRange): Promise<TeamStats> {
    await this.assertStoreInTenant(storeId);
    return this.team.getTeamStats(storeId, dateRange);
  }

  async getRecentActivity(storeId: string, limit = 20): Promise<ActivityFeed> {
    // Aggregating the activity feed across audit_logs / scans / tasks /
    // GRN events is a separate ticket. v1 ships a stable empty shape
    // so the mobile app can render the section header without crashing.
    void storeId;
    void limit;
    return { items: [], hasMore: false };
  }

  async getMultiStoreSummary(tenantId: string): Promise<MultiStoreSummary> {
    const stores = await this.storesRepo.listForTenant(tenantId);
    const dateRange = defaultDateRange();

    const perStoreKpis = await Promise.all(
      stores.map(async (s) => ({ store: s, kpis: await this.kpis.getKpis(s.id, dateRange) })),
    );

    const entries = await Promise.all(
      perStoreKpis.map(async ({ store, kpis }) => {
        const latest = await this.ohs.getLatest(tenantId, store.id);
        return {
          storeId: store.id,
          storeName: store.name,
          scansToday: kpis.scansToday,
          expiryAlerts: kpis.expiringNextWeek + kpis.expiredItems,
          pendingTasks: kpis.pendingTasks,
          healthScore: latest ? Math.round(latest.total) : computeFallbackHealthScore(kpis),
        };
      }),
    );

    const aggregateKpis = aggregate(perStoreKpis.map((p) => p.kpis));

    return {
      tenantId,
      totalStores: stores.length,
      stores: entries,
      aggregateKpis,
    };
  }

  async getHealthScore(storeId: string): Promise<HealthScoreView> {
    const tenantId = this.requireTenantId();
    await this.assertStoreInTenant(storeId);
    return this.ohs.getView(tenantId, storeId);
  }

  /* ─────────────────── helpers ─────────────────── */

  private requireTenantId(): string {
    const tenantId = this.context.getTenantId();
    if (!tenantId) {
      // The TenantScopeGuard should have rejected this request long
      // before we get here. If we somehow do, fail fast — the dashboard
      // refuses to operate without a tenant scope.
      throw new DomainNotFoundException('tenant');
    }
    return tenantId;
  }

  private async assertStoreInTenant(storeId: string): Promise<void> {
    const tenantId = this.requireTenantId();
    const store = await this.storesRepo.findByTenantAndId(tenantId, storeId);
    if (!store) throw new DomainNotFoundException(STORE_RESOURCE, storeId);
  }

  private async getSubscriptionStatus(tenantId: string): Promise<DashboardSubscription> {
    const status: SubscriptionStatus = await this.subscriptions.getStatus(tenantId);
    return {
      plan: status.plan.code,
      status: status.status,
      trialDaysRemaining: status.trialDaysRemaining,
      usagePercentage: averageUsage(status.usage.byFeature),
    };
  }

  /**
   * Re-hydrates Date fields after JSON deserialisation. The cache
   * payload is `JSON.stringify`'d so every Date became a string;
   * the dashboard contract requires real Dates so the mobile
   * client gets ISO timestamps regardless of cache hit/miss.
   */
  private rehydrate(d: ClientDashboard): ClientDashboard {
    return {
      ...d,
      generatedAt: new Date(d.generatedAt),
      alerts: {
        ...d.alerts,
        critical: d.alerts.critical.map((a) => ({ ...a, createdAt: new Date(a.createdAt) })),
        warning: d.alerts.warning.map((a) => ({ ...a, createdAt: new Date(a.createdAt) })),
        info: d.alerts.info.map((a) => ({ ...a, createdAt: new Date(a.createdAt) })),
      },
      trends: {
        ...d.trends,
        scans: d.trends.scans.map((p) => ({ ...p, date: new Date(p.date) })),
        expiryAdded: d.trends.expiryAdded.map((p) => ({ ...p, date: new Date(p.date) })),
        tasksCompleted: d.trends.tasksCompleted.map((p) => ({ ...p, date: new Date(p.date) })),
        inventoryMovements: d.trends.inventoryMovements.map((p) => ({
          ...p,
          date: new Date(p.date),
        })),
      },
      recentActivity: {
        ...d.recentActivity,
        items: d.recentActivity.items.map((it) => ({ ...it, timestamp: new Date(it.timestamp) })),
      },
      healthScore: rehydrateHealthScore(d.healthScore),
    };
  }
}

function rehydrateHealthScore(view: HealthScoreView): HealthScoreView {
  if (!view.latest) return view;
  return {
    ...view,
    latest: { ...view.latest, computedAt: new Date(view.latest.computedAt) },
  };
}

function defaultDateRange(): DateRange {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 30);
  return { from, to };
}

function averageUsage(byFeature: Record<string, { percentageUsed: number }>): number {
  const values = Object.values(byFeature ?? {});
  if (values.length === 0) return 0;
  const total = values.reduce((sum, f) => sum + (f.percentageUsed ?? 0), 0);
  return Math.round(total / values.length);
}

function fallbackSubscription(): DashboardSubscription {
  return {
    plan: 'trial',
    status: 'trial',
    trialDaysRemaining: 90,
    usagePercentage: 0,
  };
}

function emptyHealthScoreView(): HealthScoreView {
  return {
    latest: null,
    trend30d: [],
    algorithmVersion: OperationalHealthScoreService.ALGORITHM_VERSION,
  };
}

function aggregate(allKpis: DashboardKpis[]): DashboardKpis {
  if (allKpis.length === 0) {
    return {
      scansToday: 0,
      scansThisWeek: 0,
      scansThisMonth: 0,
      expiringNextWeek: 0,
      expiredItems: 0,
      pendingTasks: 0,
      overdueTasks: 0,
      completedToday: 0,
      totalProducts: 0,
      lowStockItems: 0,
      eanMatchRate: 100,
      trends: { scans: 'flat', expiry: 'flat', tasks: 'flat', inventory: 'flat' },
    };
  }
  const sum = (k: keyof DashboardKpis) =>
    allKpis.reduce((acc, x) => acc + (typeof x[k] === 'number' ? (x[k] as number) : 0), 0);
  const avgRate =
    allKpis.length > 0
      ? Math.round(allKpis.reduce((s, k) => s + k.eanMatchRate, 0) / allKpis.length)
      : 100;
  return {
    scansToday: sum('scansToday'),
    scansThisWeek: sum('scansThisWeek'),
    scansThisMonth: sum('scansThisMonth'),
    expiringNextWeek: sum('expiringNextWeek'),
    expiredItems: sum('expiredItems'),
    pendingTasks: sum('pendingTasks'),
    overdueTasks: sum('overdueTasks'),
    completedToday: sum('completedToday'),
    totalProducts: sum('totalProducts'),
    lowStockItems: sum('lowStockItems'),
    eanMatchRate: avgRate,
    trends: { scans: 'flat', expiry: 'flat', tasks: 'flat', inventory: 'flat' },
  };
}

function computeFallbackHealthScore(kpis: DashboardKpis): number {
  // Used only when the OHS history table has no row yet for a store.
  // Lightweight heuristic so the multi-store summary still renders a
  // gauge.
  let score = 100;
  if (kpis.overdueTasks > 0) score -= Math.min(20, kpis.overdueTasks * 5);
  if (kpis.expiredItems > 0) score -= Math.min(30, kpis.expiredItems * 3);
  if (kpis.lowStockItems > 0) score -= Math.min(20, kpis.lowStockItems * 2);
  if (kpis.eanMatchRate < 90) score -= 90 - kpis.eanMatchRate;
  return Math.max(0, score);
}
