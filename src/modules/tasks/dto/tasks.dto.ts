import { z } from 'zod';

/**
 * BE-19 — Consolidated task DTOs.
 *
 * Single file mirrors the BE-15/16/17/18 convention. Every schema
 * exports both `XxxSchema` and `XxxDto = z.infer<typeof XxxSchema>`.
 *
 * Caps on every list / batch endpoint to keep the request body
 * bounded — tasks management is a manager workflow, not a data
 * pipeline, so list-of-100 is plenty.
 */

const TASK_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'rejected',
  'cancelled',
  'overdue',
] as const;
const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
const TASK_TYPES = [
  'expiry-check',
  'shelf-audit',
  'inventory-count',
  'price-update',
  'cleaning',
  'restock',
  'training',
  'maintenance',
  'other',
] as const;
const RECURRENCE_TYPES = ['daily', 'weekly', 'monthly'] as const;
const ASSIGNMENT_ROLES = ['primary', 'observer'] as const;
const EVIDENCE_TYPES = ['photo', 'scan', 'note', 'video'] as const;

/* ─────────────────── Recurrence ─────────────────── */

export const RecurrencePatternSchema = z
  .object({
    type: z.enum(RECURRENCE_TYPES),
    interval: z.coerce.number().int().min(1).max(365).default(1),
    daysOfWeek: z.array(z.coerce.number().int().min(0).max(6)).max(7).optional(),
    dayOfMonth: z.coerce.number().int().min(1).max(31).optional(),
    endDate: z.coerce.date().optional(),
    occurrences: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .refine((p) => p.type !== 'weekly' || p.daysOfWeek === undefined || p.daysOfWeek.length > 0, {
    message: 'weekly recurrence with daysOfWeek must specify at least one day',
    path: ['daysOfWeek'],
  });
export type RecurrencePatternDto = z.infer<typeof RecurrencePatternSchema>;

/* ─────────────────── Evidence ─────────────────── */

export const AddEvidenceSchema = z
  .object({
    type: z.enum(EVIDENCE_TYPES),
    mediaId: z.string().uuid().optional(),
    scanSessionId: z.string().uuid().optional(),
    note: z.string().min(1).max(1000).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine(
    (e) =>
      (e.type === 'photo' && !!e.mediaId) ||
      (e.type === 'video' && !!e.mediaId) ||
      (e.type === 'scan' && !!e.scanSessionId) ||
      (e.type === 'note' && !!e.note),
    {
      message:
        'evidence payload missing the field required for its type ' +
        '(photo/video → mediaId, scan → scanSessionId, note → note)',
      path: ['type'],
    },
  );
export type AddEvidenceDto = z.infer<typeof AddEvidenceSchema>;

/* ─────────────────── Create / update ─────────────────── */

export const CreateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    type: z.enum(TASK_TYPES),
    priority: z.enum(TASK_PRIORITIES).default('medium'),
    storeId: z.string().uuid(),
    assigneeIds: z
      .array(z.string().uuid())
      .min(1, 'at least one assignee required')
      .max(20, 'cannot assign more than 20 users at once'),
    observerIds: z.array(z.string().uuid()).max(10).optional(),
    startDate: z.coerce.date().optional(),
    dueDate: z.coerce.date().optional(),
    estimatedDurationMinutes: z.coerce
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 7) // 1 week
      .optional(),
    requiresPhoto: z.boolean().default(false),
    requiresScan: z.boolean().default(false),
    minimumEvidenceCount: z.coerce.number().int().min(0).max(50).default(0),
    expiryAlertId: z.string().uuid().optional(),
    productIds: z.array(z.string().uuid()).max(500).optional(),
    scanSessionId: z.string().uuid().optional(),
    isRecurring: z.boolean().default(false),
    recurrencePattern: RecurrencePatternSchema.optional(),
    templateId: z.string().uuid().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((d) => !d.startDate || !d.dueDate || d.startDate.getTime() <= d.dueDate.getTime(), {
    message: 'startDate must be on or before dueDate',
    path: ['startDate'],
  })
  .refine((d) => !d.isRecurring || !!d.recurrencePattern, {
    message: 'recurrencePattern is required when isRecurring is true',
    path: ['recurrencePattern'],
  })
  .refine((d) => !d.requiresPhoto || d.minimumEvidenceCount >= 1, {
    message: 'minimumEvidenceCount must be at least 1 when requiresPhoto is true',
    path: ['minimumEvidenceCount'],
  })
  .refine((d) => new Set(d.assigneeIds).size === d.assigneeIds.length, {
    message: 'assigneeIds must be unique',
    path: ['assigneeIds'],
  });
export type CreateTaskDto = z.infer<typeof CreateTaskSchema>;

export const UpdateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    startDate: z.coerce.date().optional(),
    dueDate: z.coerce.date().optional(),
    estimatedDurationMinutes: z.coerce
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 7)
      .optional(),
    requiresPhoto: z.boolean().optional(),
    requiresScan: z.boolean().optional(),
    minimumEvidenceCount: z.coerce.number().int().min(0).max(50).optional(),
    productIds: z.array(z.string().uuid()).max(500).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((d) => !d.startDate || !d.dueDate || d.startDate.getTime() <= d.dueDate.getTime(), {
    message: 'startDate must be on or before dueDate',
    path: ['startDate'],
  });
export type UpdateTaskDto = z.infer<typeof UpdateTaskSchema>;

/* ─────────────────── Workflow actions ─────────────────── */

export const CompleteTaskSchema = z.object({
  notes: z.string().max(1000).optional(),
  scanSessionId: z.string().uuid().optional(),
  evidence: z.array(AddEvidenceSchema).max(20).optional(),
});
export type CompleteTaskDto = z.infer<typeof CompleteTaskSchema>;

export const RejectTaskSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});
export type RejectTaskDto = z.infer<typeof RejectTaskSchema>;

export const CancelTaskSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});
export type CancelTaskDto = z.infer<typeof CancelTaskSchema>;

export const ReassignTaskSchema = z
  .object({
    assigneeIds: z.array(z.string().uuid()).min(1, 'at least one assignee required').max(20),
    role: z.enum(ASSIGNMENT_ROLES).default('primary'),
    reason: z.string().max(500).optional(),
    /** When true revoke every existing primary assignment first. */
    replace: z.boolean().default(true),
  })
  .refine((d) => new Set(d.assigneeIds).size === d.assigneeIds.length, {
    message: 'assigneeIds must be unique',
    path: ['assigneeIds'],
  });
export type ReassignTaskDto = z.infer<typeof ReassignTaskSchema>;

/* ─────────────────── Listing / queries ─────────────────── */

const csvEnum = <T extends readonly string[]>(allowed: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      const arr = Array.isArray(v) ? v : v.split(',');
      const cleaned = arr
        .map((s) => s.trim().toLowerCase())
        .filter((s): s is T[number] => (allowed as readonly string[]).includes(s));
      return cleaned.length > 0 ? (cleaned as T[number][]) : undefined;
    });

export const ListTasksQuerySchema = z.object({
  storeId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().optional(),
  status: csvEnum(TASK_STATUSES),
  priority: csvEnum(TASK_PRIORITIES),
  type: csvEnum(TASK_TYPES),
  dueBefore: z.coerce.date().optional(),
  dueAfter: z.coerce.date().optional(),
  templateId: z.string().uuid().optional(),
  parentTaskId: z.string().uuid().optional(),
  expiryAlertId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListTasksQueryDto = z.infer<typeof ListTasksQuerySchema>;

export const MyTasksQuerySchema = z.object({
  status: csvEnum(TASK_STATUSES),
  priority: csvEnum(TASK_PRIORITIES),
  type: csvEnum(TASK_TYPES),
  storeId: z.string().uuid().optional(),
  dueBefore: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type MyTasksQueryDto = z.infer<typeof MyTasksQuerySchema>;

export const StatsQuerySchema = z.object({
  storeId: z.string().uuid().optional(),
});
export type StatsQueryDto = z.infer<typeof StatsQuerySchema>;

/* ─────────────────── Templates ─────────────────── */

export const CreateTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  type: z.enum(TASK_TYPES),
  priority: z.enum(TASK_PRIORITIES).default('medium'),
  titleTemplate: z.string().trim().min(1).max(200),
  defaultDueOffsetMinutes: z.coerce
    .number()
    .int()
    .min(0)
    .max(60 * 24 * 365)
    .optional(),
  estimatedDurationMinutes: z.coerce
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 7)
    .optional(),
  requiresPhoto: z.boolean().default(false),
  requiresScan: z.boolean().default(false),
  minimumEvidenceCount: z.coerce.number().int().min(0).max(50).default(0),
  isRecurring: z.boolean().default(false),
  recurrencePattern: RecurrencePatternSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateTemplateDto = z.infer<typeof CreateTemplateSchema>;

export const UpdateTemplateSchema = CreateTemplateSchema.partial().extend({
  isActive: z.boolean().optional(),
});
export type UpdateTemplateDto = z.infer<typeof UpdateTemplateSchema>;

export const ListTemplatesQuerySchema = z.object({
  isActive: z.coerce.boolean().optional(),
  type: z.enum(TASK_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListTemplatesQueryDto = z.infer<typeof ListTemplatesQuerySchema>;

export const InstantiateTemplateSchema = z
  .object({
    storeId: z.string().uuid(),
    assigneeIds: z.array(z.string().uuid()).min(1).max(20),
    title: z.string().trim().min(1).max(200).optional(),
    dueDate: z.coerce.date().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((d) => new Set(d.assigneeIds).size === d.assigneeIds.length, {
    message: 'assigneeIds must be unique',
    path: ['assigneeIds'],
  });
export type InstantiateTemplateDto = z.infer<typeof InstantiateTemplateSchema>;

/* ─────────────────── Auto-task from alert ─────────────────── */

export const AutoTaskFromAlertSchema = z.object({
  alertId: z.string().uuid(),
  storeId: z.string().uuid(),
  assigneeIds: z.array(z.string().uuid()).min(1).max(20),
  dueOffsetMinutes: z.coerce
    .number()
    .int()
    .min(0)
    .max(60 * 24 * 30)
    .default(60 * 24), // default: due in 24h
});
export type AutoTaskFromAlertDto = z.infer<typeof AutoTaskFromAlertSchema>;
