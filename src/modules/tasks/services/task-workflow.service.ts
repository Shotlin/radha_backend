import { Injectable } from '@nestjs/common';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';

import type { TaskStatus } from '../types/task.types';

/**
 * BE-19 — Pure state machine for task lifecycle.
 *
 *   pending     → in_progress | cancelled
 *   in_progress → completed | rejected | cancelled
 *   overdue     → in_progress | completed | cancelled
 *   rejected    → pending           (reopen)
 *   completed   → ∅                  (terminal)
 *   cancelled   → ∅                  (terminal)
 *
 * No DB. No I/O. Single responsibility: validate and explain.
 */
@Injectable()
export class TaskWorkflowService {
  static readonly TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = Object.freeze({
    pending: ['in_progress', 'cancelled'] as const,
    in_progress: ['completed', 'rejected', 'cancelled'] as const,
    completed: [] as const,
    rejected: ['pending'] as const,
    cancelled: [] as const,
    overdue: ['in_progress', 'completed', 'cancelled'] as const,
  });

  validateTransition(from: TaskStatus, to: TaskStatus): void {
    if (from === to) {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        `Task is already in status '${from}'`,
        { metadata: { from, to } },
      );
    }
    const allowed = TaskWorkflowService.TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      const code =
        from === 'completed' ? ErrorCode.TASK_ALREADY_COMPLETED : ErrorCode.BUSINESS_RULE_VIOLATION;
      throw new BusinessException(code, `Cannot transition task from '${from}' to '${to}'`, {
        metadata: { from, to, allowed: [...allowed] },
      });
    }
  }

  canTransitionTo(from: TaskStatus, to: TaskStatus): boolean {
    return (TaskWorkflowService.TRANSITIONS[from] ?? []).includes(to);
  }

  isTerminal(status: TaskStatus): boolean {
    return (TaskWorkflowService.TRANSITIONS[status] ?? []).length === 0;
  }

  getNextPossibleStatuses(current: TaskStatus): TaskStatus[] {
    return [...(TaskWorkflowService.TRANSITIONS[current] ?? [])];
  }
}
