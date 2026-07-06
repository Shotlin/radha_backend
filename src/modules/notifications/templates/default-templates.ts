import type { NotificationCategory, NotificationTemplateKey } from '../types/notification.types';

/**
 * BE-24 — In-process default templates.
 *
 * Used as fallback when the `notification_templates` table doesn't
 * have a tenant override or a global default. Each entry is a tiny
 * mustache-flavoured string ({{key}}) — the renderer does the
 * substitution.
 *
 * Templates intentionally use simple ASCII so they survive both SMS
 * (160-char concat budget) and email plain-text fallback.
 */

export interface DefaultTemplate {
  category: NotificationCategory;
  defaultChannels: Array<'email' | 'sms' | 'push' | 'in-app'>;
  subject: string;
  body: string;
  bodyHtml: string;
  smsText?: string;
  pushTitle?: string;
  pushBody?: string;
}

export const DEFAULT_TEMPLATES: Record<NotificationTemplateKey, DefaultTemplate> = {
  'task-assigned': {
    category: 'task',
    defaultChannels: ['push', 'in-app', 'email'],
    subject: 'New task assigned: {{taskTitle}}',
    body: '{{assignerName}} assigned you "{{taskTitle}}" — due {{dueAt}}.',
    bodyHtml:
      '<p><strong>{{assignerName}}</strong> assigned you ' +
      '<em>{{taskTitle}}</em>.</p><p>Due: {{dueAt}}</p>',
    pushTitle: 'New task',
    pushBody: '{{taskTitle}} — due {{dueAt}}',
  },

  'task-completed': {
    category: 'task',
    defaultChannels: ['push', 'in-app'],
    subject: 'Task completed: {{taskTitle}}',
    body: '{{completedBy}} marked "{{taskTitle}}" complete at {{completedAt}}.',
    bodyHtml:
      '<p><strong>{{completedBy}}</strong> completed ' +
      '<em>{{taskTitle}}</em> at {{completedAt}}.</p>',
    pushTitle: 'Task completed',
    pushBody: '{{taskTitle}}',
  },

  'task-overdue': {
    category: 'task',
    defaultChannels: ['push', 'in-app', 'email'],
    subject: 'Overdue: {{taskTitle}}',
    body: '"{{taskTitle}}" was due {{dueAt}} and is now overdue.',
    bodyHtml: '<p><strong>Overdue:</strong> <em>{{taskTitle}}</em> (was due {{dueAt}}).</p>',
    pushTitle: 'Overdue task',
    pushBody: '{{taskTitle}}',
  },

  'expiry-near': {
    category: 'expiry-alert',
    defaultChannels: ['push', 'in-app'],
    subject: 'Expiring soon: {{productName}}',
    body: '{{productName}} expires in {{daysRemaining}} days.',
    bodyHtml: '<p><strong>{{productName}}</strong> expires in {{daysRemaining}} days.</p>',
    pushTitle: 'Expiring soon',
    pushBody: '{{productName}} — {{daysRemaining}}d left',
  },

  'expiry-red': {
    category: 'expiry-alert',
    defaultChannels: ['push', 'in-app', 'email'],
    subject: 'Critical: {{productName}} near expiry',
    body: '{{productName}} expires in {{daysRemaining}} days — take action.',
    bodyHtml:
      '<p style="color:#b00"><strong>{{productName}}</strong> expires in ' +
      '{{daysRemaining}} days. Take action immediately.</p>',
    pushTitle: 'Critical expiry',
    pushBody: '{{productName}} — {{daysRemaining}}d left',
  },

  'expiry-expired': {
    category: 'expiry-alert',
    defaultChannels: ['in-app', 'email'],
    subject: 'Expired: {{productName}}',
    body: '{{productName}} expired on {{expiredAt}} — remove from shelf.',
    bodyHtml: '<p><strong>{{productName}}</strong> expired on {{expiredAt}}.</p>',
    pushTitle: 'Expired',
    pushBody: '{{productName}}',
  },

  'report-ready': {
    category: 'report',
    defaultChannels: ['email', 'in-app'],
    subject: 'Report ready: {{reportTitle}}',
    body: 'Your report "{{reportTitle}}" is ready. Download: {{downloadLink}} (expires {{expiresAt}}).',
    bodyHtml:
      '<p>Your report <strong>{{reportTitle}}</strong> is ready.</p>' +
      '<p><a href="{{downloadLink}}">Download</a> — expires {{expiresAt}}.</p>',
  },

  'login-alert': {
    category: 'auth',
    defaultChannels: ['email'],
    subject: 'New sign-in to your RADHA account',
    body: 'Hi {{name}}, a new sign-in was detected from {{ipAddress}} ({{deviceInfo}}) at {{loginTime}}.',
    bodyHtml:
      '<p>Hi {{name}},</p><p>A new sign-in was detected from <strong>{{ipAddress}}</strong> ' +
      '({{deviceInfo}}) at {{loginTime}}.</p>' +
      '<p>If this was not you, change your password immediately.</p>',
  },

  'daily-digest': {
    category: 'daily-insights',
    defaultChannels: ['push', 'email'],
    subject: 'Your daily summary — {{date}}',
    body: '{{scansCount}} scans, {{expiringCount}} expiring soon, {{tasksOpen}} open tasks.',
    bodyHtml:
      '<p>Your day at a glance ({{date}}):</p>' +
      '<ul><li>{{scansCount}} scans</li>' +
      '<li>{{expiringCount}} expiring soon</li>' +
      '<li>{{tasksOpen}} open tasks</li></ul>',
    pushTitle: 'Daily summary',
    pushBody: '{{scansCount}} scans · {{expiringCount}} expiring · {{tasksOpen}} open',
  },

  'weekly-report': {
    category: 'report',
    defaultChannels: ['email'],
    subject: 'Weekly report — {{weekOf}}',
    body: '{{summary}}',
    bodyHtml: '<p>Week of {{weekOf}}</p><p>{{summary}}</p>',
  },

  'subscription-renewal': {
    category: 'system',
    defaultChannels: ['email', 'in-app'],
    subject: 'Subscription renewing soon: {{planName}}',
    body: 'Your {{planName}} plan renews on {{renewsAt}} for {{amount}}.',
    bodyHtml:
      '<p>Your <strong>{{planName}}</strong> subscription renews on ' +
      '{{renewsAt}} for {{amount}}.</p>',
  },

  'trial-expiring': {
    category: 'system',
    defaultChannels: ['email', 'in-app', 'push'],
    subject: 'Your trial expires in {{daysRemaining}} days',
    body: 'Upgrade now to keep your data: {{upgradeLink}}',
    bodyHtml:
      '<p>Your RADHA trial expires in {{daysRemaining}} days.</p>' +
      '<p><a href="{{upgradeLink}}">Upgrade now</a> to keep your data.</p>',
    pushTitle: 'Trial expiring',
    pushBody: '{{daysRemaining}} days remaining',
  },

  'recall-alert': {
    category: 'recall-alert',
    defaultChannels: ['push', 'in-app', 'email'],
    subject: 'Product recall: {{productName}}',
    body: '{{productName}} has been recalled. Reason: {{reason}} ({{issuedAt}}).',
    bodyHtml:
      '<p style="color:#b00"><strong>Recall alert</strong></p>' +
      '<p>{{productName}} has been recalled.</p>' +
      '<p>Reason: {{reason}}<br>Issued: {{issuedAt}}</p>',
    pushTitle: 'Product recall',
    pushBody: '{{productName}}',
  },

  'business-activation': {
    category: 'business-activation',
    defaultChannels: ['email', 'in-app'],
    subject: 'Welcome to RADHA Business — {{tenantName}}',
    body: 'Your business account ({{tenantName}}) has been activated by {{activatedBy}}.',
    bodyHtml:
      '<p>Welcome aboard. <strong>{{tenantName}}</strong> is now active.</p>' +
      '<p>Activated by {{activatedBy}}.</p>',
  },

  generic: {
    category: 'system',
    defaultChannels: ['in-app'],
    subject: '{{subject}}',
    body: '{{body}}',
    bodyHtml: '{{html}}',
  },
};

export const TEMPLATE_KEYS = Object.keys(DEFAULT_TEMPLATES) as NotificationTemplateKey[];
