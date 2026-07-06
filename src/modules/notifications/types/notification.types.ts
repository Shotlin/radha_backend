/**
 * BE-24 — Notifications module public types.
 *
 * `INotificationsService` is the contract every other module
 * imports. The service is the only place callers should reach
 * into notifications from — sub-services (email/sms/push/router/
 * template-renderer/preference-manager) are internal.
 *
 * Channel + category enums are duplicated (as union types) at the
 * application layer so callers don't have to import the Drizzle
 * schema enums to get type-safety. The DB enums are still the source
 * of truth for storage; these mirrors stay in sync via the spec doc.
 */

export type NotificationChannel = 'email' | 'sms' | 'push' | 'in-app';

export type NotificationCategory =
  | 'auth'
  | 'expiry-alert'
  | 'task'
  | 'report'
  | 'system'
  | 'marketing'
  | 'recall-alert'
  | 'daily-insights'
  | 'business-activation';

export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

export type NotificationDeliveryStatus =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'bounced'
  | 'skipped';

/**
 * Stable template key. Adding new templates is fine; renaming or
 * removing one is a breaking change for callers and stored
 * notifications referencing the old key.
 */
export type NotificationTemplateKey =
  | 'task-assigned'
  | 'task-completed'
  | 'task-overdue'
  | 'expiry-near'
  | 'expiry-red'
  | 'expiry-expired'
  | 'report-ready'
  | 'login-alert'
  | 'daily-digest'
  | 'weekly-report'
  | 'subscription-renewal'
  | 'trial-expiring'
  | 'recall-alert'
  | 'business-activation'
  | 'generic';

/**
 * Per-template render input. Each template only knows how to read
 * one shape; passing the wrong one is a compile-time error.
 */
export interface NotificationTemplateData {
  'task-assigned': {
    taskTitle: string;
    assignerName: string;
    dueAt: string;
    deepLink?: string;
  };
  'task-completed': {
    taskTitle: string;
    completedBy: string;
    completedAt: string;
  };
  'task-overdue': {
    taskTitle: string;
    dueAt: string;
    deepLink?: string;
  };
  'expiry-near': {
    productName: string;
    daysRemaining: number;
    storeName?: string;
  };
  'expiry-red': {
    productName: string;
    daysRemaining: number;
    storeName?: string;
  };
  'expiry-expired': {
    productName: string;
    expiredAt: string;
    storeName?: string;
  };
  'report-ready': {
    reportTitle: string;
    downloadLink: string;
    expiresAt: string;
  };
  'login-alert': {
    name: string;
    ipAddress: string;
    deviceInfo: string;
    loginTime: string;
  };
  'daily-digest': {
    date: string;
    scansCount: number;
    expiringCount: number;
    tasksOpen: number;
  };
  'weekly-report': {
    weekOf: string;
    summary: string;
    downloadLink?: string;
  };
  'subscription-renewal': {
    planName: string;
    renewsAt: string;
    amount: string;
  };
  'trial-expiring': {
    daysRemaining: number;
    upgradeLink: string;
  };
  'recall-alert': {
    productName: string;
    reason: string;
    issuedAt: string;
  };
  'business-activation': {
    tenantName: string;
    activatedBy: string;
  };
  generic: {
    subject: string;
    body: string;
    html?: string;
  };
}

export interface SendNotificationDto {
  tenantId: string;
  userId: string;
  channels: NotificationChannel[];
  category: NotificationCategory;
  subject: string;
  body: string;
  bodyHtml?: string;
  data?: Record<string, unknown>;
  priority?: NotificationPriority;
  scheduledFor?: Date;
  template?: string;
  /** Deep-link material for the Mobile_App in-app inbox. */
  relatedResourceType?: string;
  relatedResourceId?: string;
  /**
   * Skip BullMQ even when queue is enabled (used by tests + the worker
   * itself when re-dispatching).
   */
  forceSync?: boolean;
}

export interface SendBulkNotificationDto {
  tenantId: string;
  userIds: string[];
  channels: NotificationChannel[];
  category: NotificationCategory;
  subject: string;
  body: string;
  bodyHtml?: string;
  data?: Record<string, unknown>;
  priority?: NotificationPriority;
  template?: string;
  relatedResourceType?: string;
  relatedResourceId?: string;
}

export interface NotificationRecipient {
  userId: string;
  email?: string;
  mobile?: string;
  fcmTokens?: string[];
  /** Per-recipient overrides for the placeholder map. */
  data?: Record<string, unknown>;
}

export interface NotificationPreferences {
  userId: string;
  channels: {
    email: boolean;
    sms: boolean;
    push: boolean;
    inApp: boolean;
  };
  /** Map of category → true/false. Missing keys default to enabled. */
  categories: Record<NotificationCategory, boolean>;
  quietHours?: {
    enabled: boolean;
    start: string; // HH:MM
    end: string; // HH:MM
    timezone: string;
  };
  digestFrequency: 'realtime' | 'daily' | 'weekly';
}

export interface UpdatePreferencesDto {
  channels?: Partial<NotificationPreferences['channels']>;
  categories?: Partial<Record<NotificationCategory, boolean>>;
  quietHours?: NotificationPreferences['quietHours'];
  digestFrequency?: NotificationPreferences['digestFrequency'];
}

export interface ChannelDeliveryResult {
  channel: NotificationChannel;
  delivered: boolean;
  error?: string;
  messageId?: string;
  providerMeta?: Record<string, unknown>;
}

export interface NotificationResult {
  notificationId: string;
  status: 'sent' | 'queued' | 'failed' | 'skipped';
  channels: ChannelDeliveryResult[];
}

export interface BulkNotificationResult {
  totalRecipients: number;
  successful: number;
  failed: number;
  errors: Array<{ userId: string; error: string }>;
}

export interface RenderedTemplate {
  subject: string;
  body: string;
  html: string;
  smsText?: string;
  pushTitle?: string;
  pushBody?: string;
}

export interface HistoryFilters {
  cursor?: string;
  limit?: number;
  category?: NotificationCategory;
  unreadOnly?: boolean;
}

export interface PaginatedNotifications {
  data: Array<{
    id: string;
    category: NotificationCategory;
    subject: string;
    body: string;
    isRead: boolean;
    createdAt: Date;
    sentAt: Date | null;
    data: Record<string, unknown> | null;
    relatedResourceType: string | null;
    relatedResourceId: string | null;
  }>;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface RegisterDeviceTokenDto {
  token: string;
  platform: 'ios' | 'android' | 'web';
  deviceId?: string;
  appVersion?: string;
}

export type FcmFailureReason =
  | 'unregistered'
  | 'invalid_argument'
  | 'sender_id_mismatch'
  | 'unavailable'
  | 'unknown';

/**
 * The single public service the rest of the app talks to. Sub-
 * services exist behind it.
 */
export interface INotificationsService {
  send(dto: SendNotificationDto): Promise<NotificationResult>;
  sendBulk(dto: SendBulkNotificationDto): Promise<BulkNotificationResult>;
  sendTemplate<K extends NotificationTemplateKey>(
    template: K,
    recipients: NotificationRecipient[],
    data: NotificationTemplateData[K],
    opts: { tenantId: string; channels?: NotificationChannel[] },
  ): Promise<NotificationResult[]>;

  getPreferences(userId: string): Promise<NotificationPreferences>;
  updatePreferences(userId: string, dto: UpdatePreferencesDto): Promise<NotificationPreferences>;

  getHistory(
    userId: string,
    tenantId: string,
    filters: HistoryFilters,
  ): Promise<PaginatedNotifications>;
  markAsRead(notificationId: string, userId: string): Promise<void>;
  markAllAsRead(userId: string): Promise<{ updated: number }>;

  registerDeviceToken(
    userId: string,
    tenantId: string | null,
    dto: RegisterDeviceTokenDto,
  ): Promise<{ id: string }>;
  unregisterDeviceToken(userId: string, token: string): Promise<void>;
}

/**
 * Dispatchable payload that travels through BullMQ. Kept tiny so the
 * Redis payload stays small — the worker re-reads the row.
 */
export interface NotificationJobPayload {
  notificationId: string;
  attempt?: number;
}

export const NOTIFICATIONS_QUEUE = 'notifications';
export const NOTIFICATIONS_JOB_DISPATCH = 'send-notification';

export const FCM_SERVICE_TOKEN = Symbol('FCM_SERVICE_TOKEN');
export const NOTIFICATIONS_QUEUE_TOKEN = Symbol('NOTIFICATIONS_QUEUE_TOKEN');
