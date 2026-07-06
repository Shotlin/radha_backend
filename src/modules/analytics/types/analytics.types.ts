/**
 * BE-29 — Analytics module public types.
 *
 * `IWebsiteAnalyticsService` and `IAppAnalyticsService` are the
 * contracts exposed to the controllers and (later) BE-30/BE-31
 * dashboards. Internal implementation classes implement these.
 */

export type WebsiteEventType =
  | 'page_view'
  | 'button_click'
  | 'pricing_view'
  | 'demo_click'
  | 'contact_click'
  | 'whatsapp_click'
  | 'app_download_click'
  | 'feature_view'
  | 'scroll_depth'
  | 'video_play'
  | 'form_submit';

export type AppEventType = 'screen_view' | 'feature_use' | 'error' | 'crash' | 'performance';

export interface DateRange {
  from: Date;
  to: Date;
}

export interface TrackWebsiteEventInput {
  type: WebsiteEventType;
  page?: string;
  pageTitle?: string;
  referrer?: string;

  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;

  userAgent?: string;
  browser?: string;
  os?: string;
  device?: string;

  /** ISO-3166 alpha-2. Country only — no city/region. */
  country?: string;

  sessionId: string;

  /** Caller-provided visitor cookie. Hashed before persist. */
  visitorId?: string;

  metadata?: Record<string, unknown>;
}

export interface TrackAppEventInput {
  eventType: AppEventType;
  category: string;
  action: string;
  label?: string;
  value?: number;
  screen?: string;
  storeId?: string;
  appVersion?: string;
  platform?: 'ios' | 'android';
  deviceModel?: string;
  metadata?: Record<string, unknown>;
}

export interface PageStat {
  page: string;
  views: number;
  uniqueVisitors: number;
}

export interface CountryStat {
  country: string;
  visitors: number;
}

export interface DeviceStat {
  device: string;
  count: number;
}

export interface TrafficSource {
  source: string;
  visitors: number;
}

export interface WebsiteStats {
  totalVisitors: number;
  uniqueVisitors: number;
  pageViews: number;
  sessions: number;
  byPage: PageStat[];
  byCountry: CountryStat[];
  byDevice: DeviceStat[];
  byTrafficSource: TrafficSource[];
  conversions: {
    contactFormSubmissions: number;
    demoRequests: number;
    appDownloadClicks: number;
    pricingViews: number;
  };
}

export interface FunnelStep {
  name: string;
  count: number;
  conversionRate: number;
  dropoffRate: number;
}

export interface FunnelData {
  steps: FunnelStep[];
  totalVisitors: number;
  totalConversions: number;
  overallConversion: number;
}

export interface UserActivity {
  userId: string;
  totalEvents: number;
  byType: Record<AppEventType, number>;
  topActions: Array<{ category: string; action: string; count: number }>;
  activeDays: number;
}

export interface TenantActivity {
  tenantId: string;
  totalEvents: number;
  uniqueUsers: number;
  byType: Record<AppEventType, number>;
}

export interface IWebsiteAnalyticsService {
  trackEvent(input: TrackWebsiteEventInput): Promise<void>;
  getStats(dateRange: DateRange): Promise<WebsiteStats>;
  getFunnel(dateRange: DateRange): Promise<FunnelData>;
  getTopPages(dateRange: DateRange, limit?: number): Promise<PageStat[]>;
  getTrafficSources(dateRange: DateRange, limit?: number): Promise<TrafficSource[]>;
}

export interface IAppAnalyticsService {
  trackEvent(input: TrackAppEventInput, userId: string, tenantId: string): Promise<void>;
  trackBatch(
    inputs: TrackAppEventInput[],
    userId: string,
    tenantId: string,
  ): Promise<{ accepted: number }>;
  getUserActivity(userId: string, tenantId: string, dateRange: DateRange): Promise<UserActivity>;
  getTenantActivity(tenantId: string, dateRange: DateRange): Promise<TenantActivity>;
}
