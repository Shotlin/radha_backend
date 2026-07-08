import {
  BusinessException,
  DomainForbiddenException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { DbService } from '@/db/db.service';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import type { CompleteTaskDto, CreateTaskDto } from '../dto/tasks.dto';
import { TaskAssignmentsRepository } from '../repositories/task-assignments.repository';
import { TaskEventsRepository } from '../repositories/task-events.repository';
import { TasksRepository } from '../repositories/tasks.repository';
import { RecurringTasksService } from '../services/recurring-tasks.service';
import { TaskAssignmentService } from '../services/task-assignment.service';
import { TaskEvidenceService } from '../services/task-evidence.service';
import { TaskWorkflowService } from '../services/task-workflow.service';
import { TasksService } from '../tasks.service';
import type { Task, TaskAssignment } from '../types/task.types';

const TENANT = 'tenant-1';
const ACTOR = 'manager-1';
const ASSIGNEE = 'staff-1';
const STORE = 'store-1';
const TASK_ID = 'task-1';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const buildAudit = (): AuditLogService =>
  ({ logAction: jest.fn(async () => undefined) }) as unknown as AuditLogService;

const dbThatRunsCallback = (): DbService =>
  ({
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb({}),
  }) as unknown as DbService;

const baseTask = (over: Partial<Task> = {}): Task =>
  ({
    id: TASK_ID,
    tenantId: TENANT,
    storeId: STORE,
    title: 'Check expiries',
    description: null,
    type: 'expiry-check',
    priority: 'high',
    status: 'pending',
    startDate: null,
    dueDate: new Date('2026-12-31T23:00:00Z'),
    startedAt: null,
    completedAt: null,
    estimatedDurationMinutes: 30,
    actualDurationMinutes: null,
    requiresPhoto: false,
    requiresScan: false,
    minimumEvidenceCount: 0,
    expiryAlertId: null,
    productIds: [],
    scanSessionId: null,
    templateId: null,
    isRecurring: false,
    recurrencePattern: null,
    parentTaskId: null,
    recurrenceOccurrenceCount: 0,
    evidenceCount: 0,
    assigneeCount: 1,
    overdueMarkedAt: null,
    metadata: {},
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: ACTOR,
    updatedBy: null,
    deletedBy: null,
    ...over,
  }) as unknown as Task;

const baseAssignment = (over: Partial<TaskAssignment> = {}): TaskAssignment =>
  ({
    id: 'assn-1',
    taskId: TASK_ID,
    tenantId: TENANT,
    role: 'primary',
    assigneeId: ASSIGNEE,
    revokedAt: null,
    ...over,
  }) as unknown as TaskAssignment;

const buildSvc = (
  overrides: {
    task?: Task | null;
    active?: TaskAssignment | null;
    spawnReturns?: Task | null;
    existingEvidence?: Awaited<ReturnType<TaskEvidenceService['listForTask']>>;
  } = {},
) => {
  const tasksRepo = {
    findByIdInTenant: jest.fn(async () => overrides.task ?? null),
    create: jest.fn(async (data: Partial<Task>) =>
      baseTask({ id: 'created', ...data, status: data.status ?? 'pending' }),
    ),
    update: jest.fn(async (id: string, data: Partial<Task>) =>
      baseTask({ ...(overrides.task ?? {}), ...data, id }),
    ),
    softDelete: jest.fn(async () => undefined),
    incrementCounter: jest.fn(async () => undefined),
    findOverdueCandidates: jest.fn(async () => []),
    markOverdue: jest.fn(async () => undefined),
    listForTenant: jest.fn(async () => []),
    getStats: jest.fn(async () => ({
      storeId: null,
      total: 0,
      byStatus: {
        pending: 0,
        in_progress: 0,
        completed: 0,
        rejected: 0,
        cancelled: 0,
        overdue: 0,
      },
      byPriority: { low: 0, medium: 0, high: 0, urgent: 0 },
      byType: {
        'expiry-check': 0,
        'shelf-audit': 0,
        'inventory-count': 0,
        'price-update': 0,
        cleaning: 0,
        restock: 0,
        training: 0,
        maintenance: 0,
        other: 0,
      },
      byAssignee: [],
      averageCompletionMinutes: null,
      onTimeRate: null,
    })),
    getAssigneeStats: jest.fn(async () => []),
  } as unknown as TasksRepository;

  const assignmentsRepo = {
    listAllForTask: jest.fn(async () => []),
    listTasksForUser: jest.fn(async () => []),
  } as unknown as TaskAssignmentsRepository;

  const eventsRepo = {
    create: jest.fn(async () => undefined),
    findByTask: jest.fn(async () => []),
  } as unknown as TaskEventsRepository;

  const workflow = new TaskWorkflowService();

  const assignments = {
    assignBatch: jest.fn(async () => []),
    reassign: jest.fn(async () => ({ revokedCount: 1, addedAssignments: [] })),
    assertActiveAssignment: jest.fn(async () => {
      if (overrides.active === undefined) return baseAssignment();
      if (overrides.active === null) {
        throw new DomainForbiddenException('You are not assigned to this task');
      }
      return overrides.active;
    }),
  } as unknown as TaskAssignmentService;

  const evidence = {
    listForTask: jest.fn(async () => overrides.existingEvidence ?? []),
    add: jest.fn(async () => undefined),
    addMany: jest.fn(async () => []),
    ensureRequirementsMet: jest.fn(),
    remove: jest.fn(async () => undefined),
  } as unknown as TaskEvidenceService;

  const recurring = {
    spawnNextOccurrence: jest.fn(async () => overrides.spawnReturns ?? null),
  } as unknown as RecurringTasksService;

  const svc = new TasksService(
    dbThatRunsCallback(),
    tasksRepo,
    assignmentsRepo,
    eventsRepo,
    workflow,
    assignments,
    evidence,
    recurring,
    buildAudit(),
    buildLogger(),
  );

  return {
    svc,
    tasksRepo,
    assignmentsRepo,
    eventsRepo,
    assignments,
    evidence,
    recurring,
  };
};

describe('TasksService.create', () => {
  it('creates the task, assigns primaries + observers, logs created event', async () => {
    const { svc, tasksRepo, assignments, eventsRepo } = buildSvc();
    const dto: CreateTaskDto = {
      title: 'Check expiries',
      type: 'expiry-check',
      priority: 'high',
      storeId: STORE,
      assigneeIds: [ASSIGNEE, 'staff-2'],
      observerIds: ['observer-1'],
      requiresPhoto: false,
      requiresScan: false,
      minimumEvidenceCount: 0,
      isRecurring: false,
    };
    const out = await svc.create(TENANT, ACTOR, dto);
    expect(out.id).toBe('created');
    expect(tasksRepo.create as jest.Mock).toHaveBeenCalled();
    expect((assignments.assignBatch as jest.Mock).mock.calls[0][1]).toEqual([ASSIGNEE, 'staff-2']);
    expect((assignments.assignBatch as jest.Mock).mock.calls[1][1]).toEqual(['observer-1']);
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0].type).toBe('created');
  });
});

describe('TasksService.start', () => {
  it('throws when task missing', async () => {
    const { svc } = buildSvc({ task: null });
    await expect(svc.start(TENANT, ASSIGNEE, TASK_ID)).rejects.toBeInstanceOf(
      DomainNotFoundException,
    );
  });

  it('throws DomainForbiddenException when not assigned', async () => {
    const { svc } = buildSvc({ task: baseTask(), active: null });
    await expect(svc.start(TENANT, 'other-user', TASK_ID)).rejects.toBeInstanceOf(
      DomainForbiddenException,
    );
  });

  it('rejects when task already in_progress', async () => {
    const { svc } = buildSvc({ task: baseTask({ status: 'in_progress' }) });
    await expect(svc.start(TENANT, ASSIGNEE, TASK_ID)).rejects.toBeInstanceOf(BusinessException);
  });

  it('flips pending → in_progress and stamps startedAt', async () => {
    const { svc, tasksRepo, eventsRepo } = buildSvc({ task: baseTask() });
    const out = await svc.start(TENANT, ASSIGNEE, TASK_ID);
    expect(out.status).toBe('in_progress');
    const payload = (tasksRepo.update as jest.Mock).mock.calls[0][1];
    expect(payload.status).toBe('in_progress');
    expect(payload.startedAt).toBeInstanceOf(Date);
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0].type).toBe('started');
  });
});

describe('TasksService.complete', () => {
  it('rejects when minimum evidence not met', async () => {
    const { svc, evidence } = buildSvc({
      task: baseTask({ status: 'in_progress', minimumEvidenceCount: 2 }),
      existingEvidence: [],
    });
    (evidence.ensureRequirementsMet as jest.Mock).mockImplementationOnce(() => {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Minimum 2 evidence items required to complete this task',
      );
    });
    await expect(
      svc.complete(TENANT, ASSIGNEE, TASK_ID, {} as CompleteTaskDto),
    ).rejects.toBeInstanceOf(BusinessException);
  });

  it('flips in_progress → completed, persists actualDurationMinutes', async () => {
    const startedAt = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago
    const { svc, tasksRepo } = buildSvc({
      task: baseTask({ status: 'in_progress', startedAt }),
    });
    const out = await svc.complete(TENANT, ASSIGNEE, TASK_ID, {});
    expect(out.status).toBe('completed');
    const payload = (tasksRepo.update as jest.Mock).mock.calls[0][1];
    expect(payload.actualDurationMinutes).toBeGreaterThanOrEqual(4);
    expect(payload.completedAt).toBeInstanceOf(Date);
  });

  it('attaches scanSessionId when provided', async () => {
    const { svc, tasksRepo } = buildSvc({
      task: baseTask({ status: 'in_progress' }),
    });
    await svc.complete(TENANT, ASSIGNEE, TASK_ID, {
      scanSessionId: '00000000-0000-0000-0000-000000000999',
    });
    const payload = (tasksRepo.update as jest.Mock).mock.calls[0][1];
    expect(payload.scanSessionId).toBe('00000000-0000-0000-0000-000000000999');
  });

  it('triggers recurring spawn when isRecurring=true', async () => {
    const child = baseTask({ id: 'child-1' });
    const { svc, recurring } = buildSvc({
      task: baseTask({ status: 'in_progress', isRecurring: true }),
      spawnReturns: child,
    });
    await svc.complete(TENANT, ASSIGNEE, TASK_ID, {});
    expect(recurring.spawnNextOccurrence as jest.Mock).toHaveBeenCalled();
  });

  it('does not spawn when not recurring', async () => {
    const { svc, recurring } = buildSvc({
      task: baseTask({ status: 'in_progress', isRecurring: false }),
    });
    await svc.complete(TENANT, ASSIGNEE, TASK_ID, {});
    expect(recurring.spawnNextOccurrence as jest.Mock).not.toHaveBeenCalled();
  });
});

describe('TasksService.cancel', () => {
  it('throws when task missing', async () => {
    const { svc } = buildSvc({ task: null });
    await expect(svc.cancel(TENANT, ACTOR, TASK_ID, 'oops')).rejects.toBeInstanceOf(
      DomainNotFoundException,
    );
  });

  it('rejects cancelling a completed task', async () => {
    const { svc } = buildSvc({ task: baseTask({ status: 'completed' }) });
    await expect(svc.cancel(TENANT, ACTOR, TASK_ID, 'why')).rejects.toBeInstanceOf(
      BusinessException,
    );
  });

  it('cancels a pending task with a reason', async () => {
    const { svc, eventsRepo } = buildSvc({ task: baseTask() });
    const out = await svc.cancel(TENANT, ACTOR, TASK_ID, 'no longer needed');
    expect(out.status).toBe('cancelled');
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0]).toMatchObject({
      type: 'cancelled',
      notes: 'no longer needed',
    });
  });
});

describe('TasksService.reject', () => {
  it('flips in_progress → rejected with the reason captured', async () => {
    const { svc, eventsRepo } = buildSvc({
      task: baseTask({ status: 'in_progress' }),
    });
    const out = await svc.reject(TENANT, ASSIGNEE, TASK_ID, 'cannot complete');
    expect(out.status).toBe('rejected');
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0]).toMatchObject({
      type: 'rejected',
      notes: 'cannot complete',
    });
  });
});

describe('TasksService.update', () => {
  it('rejects updates on terminal-status tasks', async () => {
    const { svc } = buildSvc({ task: baseTask({ status: 'completed' }) });
    await expect(svc.update(TENANT, ACTOR, TASK_ID, { title: 'new' })).rejects.toBeInstanceOf(
      BusinessException,
    );
  });

  it('persists field changes and logs an updated event', async () => {
    const { svc, tasksRepo, eventsRepo } = buildSvc({ task: baseTask() });
    await svc.update(TENANT, ACTOR, TASK_ID, { title: 'New title', priority: 'urgent' });
    expect(tasksRepo.update as jest.Mock).toHaveBeenCalled();
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0].type).toBe('updated');
  });
});

describe('TasksService.markOverdue', () => {
  it('returns 0/0 when nothing overdue', async () => {
    const { svc } = buildSvc();
    const result = await svc.markOverdue(new Date());
    expect(result).toEqual({ scanned: 0, marked: 0 });
  });

  it('marks each candidate and logs overdue events', async () => {
    const { svc, tasksRepo, eventsRepo } = buildSvc();
    (tasksRepo.findOverdueCandidates as jest.Mock).mockResolvedValueOnce([
      baseTask({ id: 'a', status: 'pending' }),
      baseTask({ id: 'b', status: 'in_progress' }),
    ]);
    const result = await svc.markOverdue(new Date('2027-01-01T00:00:00Z'));
    expect(result.scanned).toBe(2);
    expect(result.marked).toBe(2);
    expect((tasksRepo.markOverdue as jest.Mock).mock.calls).toHaveLength(2);
    expect(
      (eventsRepo.create as jest.Mock).mock.calls
        .map((c) => c[0].type)
        .filter((t) => t === 'overdue'),
    ).toHaveLength(2);
  });
});
