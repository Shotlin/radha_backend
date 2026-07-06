import type {
  TaskAssignmentRow,
  TaskEventRow,
  TaskEvidenceRow,
  TaskRow,
  TaskTemplateRow,
} from '@/db/schema/tasks';

/**
 * BE-19 — Domain types.
 *
 * Schema rows are re-exported under shorter names so consumers
 * (`services/`, `repositories/`, controller, tests) can import a
 * stable identifier without reaching into `db/schema/...`.
 */

export type Task = TaskRow;
export type TaskAssignment = TaskAssignmentRow;
export type TaskEvent = TaskEventRow;
export type TaskEvidence = TaskEvidenceRow;
export type TaskTemplate = TaskTemplateRow;

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'overdue';

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export type TaskType =
  | 'expiry-check'
  | 'shelf-audit'
  | 'inventory-count'
  | 'price-update'
  | 'cleaning'
  | 'restock'
  | 'training'
  | 'maintenance'
  | 'other';

export type TaskAssignmentRoleType = 'primary' | 'observer';

export type TaskEvidenceType = 'photo' | 'scan' | 'note' | 'video';

export type TaskEventType =
  | 'created'
  | 'assigned'
  | 'started'
  | 'updated'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'reassigned'
  | 'unassigned'
  | 'evidence_added'
  | 'evidence_removed'
  | 'comment'
  | 'status_changed'
  | 'overdue'
  | 'recurrence_spawned';

/* ─────────────────── Recurrence ─────────────────── */

export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly';

export interface RecurrencePattern {
  type: RecurrenceFrequency;
  interval: number; // every N days/weeks/months
  daysOfWeek?: number[]; // 0–6, Sunday=0; weekly only
  dayOfMonth?: number; // 1–31, monthly only
  endDate?: Date;
  occurrences?: number;
}

/* ─────────────────── Filters ─────────────────── */

export interface TaskFilters {
  storeId?: string;
  assigneeId?: string;
  status?: TaskStatus[];
  priority?: TaskPriority[];
  type?: TaskType[];
  dueBefore?: Date;
  dueAfter?: Date;
  templateId?: string;
  parentTaskId?: string;
  expiryAlertId?: string;
  /** When true include soft-deleted (audit only). */
  includeDeleted?: boolean;
  limit?: number;
}

export interface MyTasksFilters {
  status?: TaskStatus[];
  priority?: TaskPriority[];
  type?: TaskType[];
  storeId?: string;
  dueBefore?: Date;
  limit?: number;
}

/* ─────────────────── Aggregates ─────────────────── */

export interface AssigneeStat {
  userId: string;
  total: number;
  completed: number;
}

export interface TaskStats {
  storeId: string | null;
  total: number;
  byStatus: Record<TaskStatus, number>;
  byPriority: Record<TaskPriority, number>;
  byType: Record<TaskType, number>;
  byAssignee: AssigneeStat[];
  averageCompletionMinutes: number | null;
  /** Percentage of completed tasks finished before their due date. */
  onTimeRate: number | null;
}

/* ─────────────────── Detail view ─────────────────── */

export interface TaskWithDetails extends Task {
  assignments: TaskAssignment[];
  events: TaskEventRow[];
  evidence: TaskEvidenceRow[];
}

/* ─────────────────── Sweep result (BE-24 cron) ─────────────────── */

export interface OverdueSweepResult {
  scanned: number;
  marked: number;
}
