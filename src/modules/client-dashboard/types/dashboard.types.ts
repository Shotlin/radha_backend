/**
 * BE-30 — Public types and interfaces for the Client Dashboard.
 *
 * These types are the single source of truth for the dashboard
 * payload shape. The mobile app consumes them via
 * `` re-exports (orchestrator follow-up) so
 * field names are intentionally stable here.
 */

/* ─────────────────── Date range + trends ─────────────────── */

export interface DateRange {
  from: Date;
  to: Date;
}

export type TrendDirection = 'up' | 'down' | 'flat';

/* ─────────────────── KPI section ─────────────────── */

export interface DashboardKpis {
  scansToday: number;
  scansThisWeek: number;
  scansThisMonth: number;

  expiringNextWeek: number;
  expiredItems: number;

  pendingTasks: number;
  overdueTasks: number;
  completedToday: number;

  totalProducts: number;
  lowStockItems: number;

  /** EAN match rate as a 0–100 percentage. */
  eanMatchRate: number;

  trends: {
    scans: TrendDirection;
    expiry: TrendDirection;
    tasks: TrendDirection;
    inventory: TrendDirection;
  };
}

/* ─────────────────── Alerts ─────────────────── */

export type AlertType =
  | 'expiry_red'
  | 'expiry_yellow'
  | 'low_stock'
  | 'task_overdue'
  | 'ean_mismatch_spike'
  | 'system';

export interface AlertItem {
  id: string;
  type: AlertType;
  title: string;
  description: string;
  count: number;
  actionUrl?: string;
  createdAt: Date;
}

export interface DashboardAlerts {
  total: number;
  critical: AlertItem[];
  warning: AlertItem[];
  info: AlertItem[];
}

/* ─────────────────── Quick actions ─────────────────── */

export type QuickActionType =
  | 'scan'
  | 'add_product'
  | 'create_grn'
  | 'create_task'
  | 'view_alerts'
  | 'generate_report';

export interface QuickAction {
  id: string;
  type: QuickActionType;
  label: string;
  icon: string;
  badgeCount?: number;
  enabled: boolean;
  /** Free-form reason populated when `enabled = false`. */
  reason?: string;
}

/* ─────────────────── Trends ─────────────────── */

export interface DataPoint {
  date: Date;
  value: number;
}

export interface TrendData {
  scans: DataPoint[];
  expiryAdded: DataPoint[];
  tasksCompleted: DataPoint[];
  inventoryMovements: DataPoint[];
}

/* ─────────────────── Team ─────────────────── */

export interface TopScanner {
  userId: string;
  userName: string;
  scanCount: number;
  avatarUrl?: string;
}

export interface TaskCompletionLeader {
  userId: string;
  userName: string;
  completedCount: number;
  /** 0–100 completion rate (completed / assigned). */
  completionRate: number;
}

export interface TeamStats {
  totalMembers: number;
  activeToday: number;
  topScanners: TopScanner[];
  taskCompletionLeaders: TaskCompletionLeader[];
}

/* ─────────────────── Activity feed ─────────────────── */

export type ActivityItemType =
  | 'scan'
  | 'task_completed'
  | 'grn_posted'
  | 'product_added'
  | 'expiry_alert';

export interface ActivityItem {
  id: string;
  type: ActivityItemType;
  actorName: string;
  actorAvatarUrl?: string;
  action: string;
  target: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface ActivityFeed {
  items: ActivityItem[];
  hasMore: boolean;
}

/* ─────────────────── Subscription card ─────────────────── */

export interface DashboardSubscription {
  plan: string;
  status: string;
  trialDaysRemaining?: number;
  /** Average usage % across all features (0–100, integer). */
  usagePercentage: number;
}

/* ─────────────────── Operational Health Score (v2) ─────────────────── */

export type OhsComponentName =
  | 'compliance'
  | 'expiryManagement'
  | 'inventoryAccuracy'
  | 'taskCompletion'
  | 'teamActivity'
  | 'vendorQuality';

/** Each component returns a 0..1 normalised score plus a debug input snapshot. */
export interface ComponentResult {
  /** Normalised score in [0, 1]. */
  rawScore: number;
  /** Verbatim inputs used by the calculator, persisted to `raw_inputs`. */
  rawInputs: Record<string, unknown>;
}

export interface ComponentInput {
  tenantId: string;
  storeId: string;
  /** End date of the rolling window. Calculators use 30 days back. */
  asOf: Date;
}

export interface IComponentCalculator {
  readonly name: OhsComponentName;
  /** Weight in [0, 1]. The six weights sum to 1. */
  readonly weight: number;
  compute(input: ComponentInput): Promise<ComponentResult>;
}

export interface HealthScoreSnapshot {
  /** 0..100 weighted total, rounded to 2 decimals. */
  total: number;
  /** Per-component normalised score in [0, 1]. */
  breakdown: Record<OhsComponentName, number>;
  /** Per-component raw inputs persisted to the row's `rawInputs` jsonb. */
  rawInputs: Record<OhsComponentName, Record<string, unknown>>;
  algorithmVersion: string;
}

export interface HealthScorePersistedRow {
  id: string;
  tenantId: string;
  storeId: string | null;
  computedForDate: string; // ISO date YYYY-MM-DD
  algorithmVersion: string;
  total: number;
  breakdown: Record<OhsComponentName, number>;
  computedAt: Date;
}

export interface HealthScoreTrendPoint {
  date: string; // ISO date YYYY-MM-DD
  total: number;
  algorithmVersion: string;
}

export interface HealthScoreView {
  latest: HealthScorePersistedRow | null;
  trend30d: HealthScoreTrendPoint[];
  algorithmVersion: string;
}

/* ─────────────────── Top-level dashboard payload ─────────────────── */

export interface DashboardOptions {
  dateRange?: DateRange;
  includeKpis?: boolean;
  includeAlerts?: boolean;
  includeTrends?: boolean;
  includeTeam?: boolean;
}

export interface ClientDashboard {
  storeId: string;
  storeName: string;
  generatedAt: Date;

  kpis: DashboardKpis;
  alerts: DashboardAlerts;
  quickActions: QuickAction[];
  trends: TrendData;
  team: TeamStats;
  recentActivity: ActivityFeed;

  subscriptionStatus: DashboardSubscription;

  /** Populated by the OHS service from the latest persisted row. */
  healthScore: HealthScoreView;
}

/* ─────────────────── Multi-store summary ─────────────────── */

export interface MultiStoreEntry {
  storeId: string;
  storeName: string;
  scansToday: number;
  expiryAlerts: number;
  pendingTasks: number;
  /** Mirrors the latest OHS total when available, else a heuristic. */
  healthScore: number;
}

export interface MultiStoreSummary {
  tenantId: string;
  totalStores: number;
  stores: MultiStoreEntry[];
  aggregateKpis: DashboardKpis;
}

/* ─────────────────── Cache invalidator contract ─────────────────── */

/**
 * Implemented by `DashboardCacheService`. Consumed by other modules'
 * write paths (scan-items, expiry-records, tasks) so that a fresh
 * write busts the dashboard cache for the affected store.
 *
 * Keeping it as an interface lets the orchestrator wire repositories
 * to call `dashboardCache.invalidateStore(storeId)` without pulling
 * the dashboard module into their own dependency graph — they only
 * see the interface.
 */
export interface IDashboardCacheInvalidator {
  invalidateStore(storeId: string): Promise<void>;
  invalidateTenant(tenantId: string): Promise<void>;
}

export const DASHBOARD_CACHE_INVALIDATOR_TOKEN = Symbol('DASHBOARD_CACHE_INVALIDATOR_TOKEN');

/* ─────────────────── Service interface ─────────────────── */

export interface IClientDashboardService {
  getDashboard(storeId: string, options?: DashboardOptions): Promise<ClientDashboard>;
  getKpis(storeId: string, dateRange: DateRange): Promise<DashboardKpis>;
  getAlerts(storeId: string): Promise<DashboardAlerts>;
  getQuickActions(storeId: string, userId: string): Promise<QuickAction[]>;
  getTrends(storeId: string, dateRange: DateRange): Promise<TrendData>;
  getTeamPerformance(storeId: string, dateRange: DateRange): Promise<TeamStats>;
  getRecentActivity(storeId: string, limit?: number): Promise<ActivityFeed>;
  getMultiStoreSummary(tenantId: string): Promise<MultiStoreSummary>;
  getHealthScore(storeId: string): Promise<HealthScoreView>;
}
