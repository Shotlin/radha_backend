import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { auditColumns, baseColumns, softDeleteColumn } from './_base';

/**
 * BE-19 — Task management.
 *
 * Five tables in a single file because they share lifecycle and ship
 * in one migration:
 *   - `tasks`             — work items (CRUD + state-machine status)
 *   - `task_assignments`  — many-to-many: task ↔ assignee (primary | observer)
 *   - `task_events`       — append-only audit trail (one row per
 *                           transition / evidence add / reassignment)
 *   - `task_evidence`     — photos / scans / notes / videos attached
 *                           to a task as proof of completion
 *   - `task_templates`    — reusable definitions (`Daily shelf check`)
 *
 * Tenant scoping is required everywhere; `task_assignments`,
 * `task_events`, and `task_evidence` inherit visibility through
 * their parent task via cascade FKs.
 *
 * Concurrency invariants enforced at the DB level:
 *   - exactly one **active** assignment per `(task, user)` via the
 *     partial unique index `task_assignments_active_uniq`
 *     (excludes revoked rows so a re-assignment to a previously
 *     revoked user is a clean insert).
 *   - the BE-24 daily cron uses `idx_tasks_store_status_due` to
 *     stream "open work due in the next N days" without a sort.
 */

export const taskStatusEnum = pgEnum('task_status', [
  'pending',
  'in_progress',
  'completed',
  'rejected',
  'cancelled',
  'overdue',
]);

export const taskPriorityEnum = pgEnum('task_priority', ['low', 'medium', 'high', 'urgent']);

export const taskTypeEnum = pgEnum('task_type', [
  'expiry-check',
  'shelf-audit',
  'inventory-count',
  'price-update',
  'cleaning',
  'restock',
  'training',
  'maintenance',
  'other',
]);

export const taskAssignmentRoleEnum = pgEnum('task_assignment_role', ['primary', 'observer']);

export const taskEventTypeEnum = pgEnum('task_event_type', [
  'created',
  'assigned',
  'started',
  'updated',
  'completed',
  'rejected',
  'cancelled',
  'reassigned',
  'unassigned',
  'evidence_added',
  'evidence_removed',
  'comment',
  'status_changed',
  'overdue',
  'recurrence_spawned',
]);

export const taskEvidenceTypeEnum = pgEnum('task_evidence_type', [
  'photo',
  'scan',
  'note',
  'video',
]);

/* ─────────────────── tasks ─────────────────── */

export const tasks = pgTable(
  'tasks',
  {
    ...baseColumns,
    ...softDeleteColumn,
    ...auditColumns,
    tenantId: uuid('tenant_id').notNull(),
    storeId: uuid('store_id').notNull(),

    title: varchar('title', { length: 200 }).notNull(),
    description: varchar('description', { length: 2000 }),

    type: taskTypeEnum('type').notNull(),
    priority: taskPriorityEnum('priority').notNull().default('medium'),
    status: taskStatusEnum('status').notNull().default('pending'),

    startDate: timestamp('start_date', { withTimezone: true }),
    dueDate: timestamp('due_date', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    estimatedDurationMinutes: integer('estimated_duration_minutes'),
    actualDurationMinutes: integer('actual_duration_minutes'),

    requiresPhoto: boolean('requires_photo').notNull().default(false),
    requiresScan: boolean('requires_scan').notNull().default(false),
    minimumEvidenceCount: integer('minimum_evidence_count').notNull().default(0),

    /** BE-18 expiry alert this task auto-resolves on completion. */
    expiryAlertId: uuid('expiry_alert_id'),
    /** Free-form list of product UUIDs the task touches (snapshot). */
    productIds: jsonb('product_ids').$type<string[]>().notNull().default([]),
    /** BE-16 scan session attached as evidence. */
    scanSessionId: uuid('scan_session_id'),

    /** When the task was created from a template. */
    templateId: uuid('template_id'),

    /** Recurring-task plumbing — populated only on recurring parents. */
    isRecurring: boolean('is_recurring').notNull().default(false),
    recurrencePattern: jsonb('recurrence_pattern').$type<Record<string, unknown>>(),
    parentTaskId: uuid('parent_task_id'),
    /** Number of children this recurring parent has spawned so far. */
    recurrenceOccurrenceCount: integer('recurrence_occurrence_count').notNull().default(0),

    /** Denormalised counters refreshed on add/remove. */
    evidenceCount: integer('evidence_count').notNull().default(0),
    assigneeCount: integer('assignee_count').notNull().default(0),

    /** Marked overdue by BE-24 cron. Mirrors `status='overdue'`. */
    overdueMarkedAt: timestamp('overdue_marked_at', { withTimezone: true }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    storeStatusDueIdx: index('idx_tasks_store_status_due').on(t.storeId, t.status, t.dueDate),
    tenantStatusIdx: index('idx_tasks_tenant_status').on(t.tenantId, t.status),
    typeIdx: index('idx_tasks_tenant_type').on(t.tenantId, t.type),
    expiryAlertIdx: index('idx_tasks_expiry_alert').on(t.expiryAlertId),
    parentIdx: index('idx_tasks_parent').on(t.parentTaskId),
    templateIdx: index('idx_tasks_template').on(t.templateId),
    dueIdx: index('idx_tasks_due').on(t.dueDate),
    /**
     * One active task per `(expiry_alert_id)` so the auto-task
     * generator can blindly call `insertIfMissing` without racing.
     * Soft-deleted tasks don't count.
     */
    expiryAlertActiveUniq: uniqueIndex('idx_tasks_expiry_alert_active_uniq')
      .on(t.expiryAlertId)
      .where(sql`expiry_alert_id IS NOT NULL AND deleted_at IS NULL`),
  }),
);

export type TaskRow = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;

/* ─────────────────── task_assignments ─────────────────── */

export const taskAssignments = pgTable(
  'task_assignments',
  {
    ...baseColumns,
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    assigneeId: uuid('assignee_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),

    role: taskAssignmentRoleEnum('role').notNull().default('primary'),

    assignedBy: uuid('assigned_by').notNull(),
    assignedAt: timestamp('assigned_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),

    /**
     * Reassignment is modelled as revoke + create rather than mutate
     * — keeps the audit trail clean and the partial-unique index
     * lets the same user be re-added later if the task is bounced
     * back to them.
     */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by'),
    revokedReason: varchar('revoked_reason', { length: 500 }),
  },
  (t) => ({
    taskIdx: index('idx_task_assignments_task').on(t.taskId),
    assigneeIdx: index('idx_task_assignments_assignee').on(t.assigneeId, t.tenantId),
    activeUniq: uniqueIndex('idx_task_assignments_active_uniq')
      .on(t.taskId, t.assigneeId)
      .where(sql`revoked_at IS NULL`),
  }),
);

export type TaskAssignmentRow = typeof taskAssignments.$inferSelect;
export type NewTaskAssignment = typeof taskAssignments.$inferInsert;

/* ─────────────────── task_events ─────────────────── */

export const taskEvents = pgTable(
  'task_events',
  {
    ...baseColumns,
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').notNull(),

    type: taskEventTypeEnum('type').notNull(),
    actorId: uuid('actor_id').notNull(),

    fromStatus: taskStatusEnum('from_status'),
    toStatus: taskStatusEnum('to_status'),

    notes: varchar('notes', { length: 1000 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    taskCreatedIdx: index('idx_task_events_task_created').on(t.taskId, t.createdAt),
    typeIdx: index('idx_task_events_type').on(t.tenantId, t.type),
  }),
);

export type TaskEventRow = typeof taskEvents.$inferSelect;
export type NewTaskEvent = typeof taskEvents.$inferInsert;

/* ─────────────────── task_evidence ─────────────────── */

export const taskEvidence = pgTable(
  'task_evidence',
  {
    ...baseColumns,
    ...softDeleteColumn,
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').notNull(),

    type: taskEvidenceTypeEnum('type').notNull(),

    /** BE-13 media-asset id for `photo` / `video` evidence. */
    mediaId: uuid('media_id'),
    /** BE-16 scan-session id for `scan` evidence. */
    scanSessionId: uuid('scan_session_id'),

    note: varchar('note', { length: 1000 }),
    addedBy: uuid('added_by').notNull(),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    taskIdx: index('idx_task_evidence_task').on(t.taskId, t.createdAt),
    typeIdx: index('idx_task_evidence_type').on(t.type),
  }),
);

export type TaskEvidenceRow = typeof taskEvidence.$inferSelect;
export type NewTaskEvidence = typeof taskEvidence.$inferInsert;

/* ─────────────────── task_templates ─────────────────── */

export const taskTemplates = pgTable(
  'task_templates',
  {
    ...baseColumns,
    ...softDeleteColumn,
    ...auditColumns,
    tenantId: uuid('tenant_id').notNull(),

    name: varchar('name', { length: 200 }).notNull(),
    description: varchar('description', { length: 2000 }),

    type: taskTypeEnum('type').notNull(),
    priority: taskPriorityEnum('priority').notNull().default('medium'),

    titleTemplate: varchar('title_template', { length: 200 }).notNull(),
    /**
     * Default due-date offset from the moment the template is
     * instantiated, in minutes. e.g. 1440 = "due tomorrow".
     */
    defaultDueOffsetMinutes: integer('default_due_offset_minutes'),
    estimatedDurationMinutes: integer('estimated_duration_minutes'),

    requiresPhoto: boolean('requires_photo').notNull().default(false),
    requiresScan: boolean('requires_scan').notNull().default(false),
    minimumEvidenceCount: integer('minimum_evidence_count').notNull().default(0),

    isRecurring: boolean('is_recurring').notNull().default(false),
    recurrencePattern: jsonb('recurrence_pattern').$type<Record<string, unknown>>(),

    isActive: boolean('is_active').notNull().default(true),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    tenantActiveIdx: index('idx_task_templates_tenant_active').on(t.tenantId, t.isActive),
    nameUniq: uniqueIndex('idx_task_templates_name_uniq')
      .on(t.tenantId, t.name)
      .where(sql`deleted_at IS NULL`),
  }),
);

export type TaskTemplateRow = typeof taskTemplates.$inferSelect;
export type NewTaskTemplate = typeof taskTemplates.$inferInsert;
