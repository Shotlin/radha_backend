import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { auditActionEnum } from './_enums';
import { sql } from 'drizzle-orm';

/**
 * BE-05 ships `audit_logs` so the BE-04 `AuditLogService` immediately
 * has somewhere to land its entries. Future phases (BE-31 App Owner
 * Dashboard, BE-53 Admin Impersonation) read from this table.
 *
 * Tenant id is nullable because system-level events ("login", "OTP
 * delivered before tenant resolved") need to land here too.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    action: auditActionEnum('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    userId: uuid('user_id'),
    tenantId: uuid('tenant_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    success: boolean('success').notNull(),
    errorCode: text('error_code'),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    byTenantTime: index('audit_logs_tenant_time_idx').on(t.tenantId, t.occurredAt),
    byUserTime: index('audit_logs_user_time_idx').on(t.userId, t.occurredAt),
    byResource: index('audit_logs_resource_idx').on(t.resourceType, t.resourceId),
    byAction: index('audit_logs_action_idx').on(t.action),
  }),
);

export type AuditLogRow = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
