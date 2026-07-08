import { LoggerService } from '@/logging/logger.service';

import { TaskAssignmentsRepository } from '../repositories/task-assignments.repository';
import { TaskEventsRepository } from '../repositories/task-events.repository';
import { TasksRepository } from '../repositories/tasks.repository';
import { RecurringTasksService } from '../services/recurring-tasks.service';
import type { Task, TaskAssignment } from '../types/task.types';

const TENANT = 'tenant-1';
const ACTOR = 'manager-1';
const TASK_ID = 'task-1';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const baseTask = (over: Partial<Task> = {}): Task =>
  ({
    id: TASK_ID,
    tenantId: TENANT,
    storeId: 'store-1',
    title: 'Daily check',
    description: 'desc',
    type: 'shelf-audit',
    priority: 'medium',
    status: 'completed',
    dueDate: new Date('2026-06-01T10:00:00Z'),
    completedAt: new Date('2026-06-01T11:00:00Z'),
    requiresPhoto: false,
    requiresScan: false,
    minimumEvidenceCount: 0,
    productIds: [],
    isRecurring: true,
    recurrencePattern: { type: 'daily', interval: 1 },
    parentTaskId: null,
    recurrenceOccurrenceCount: 0,
    metadata: {},
    estimatedDurationMinutes: 30,
    templateId: null,
    ...over,
  }) as unknown as Task;

const buildSvc = (
  overrides: {
    active?: TaskAssignment[];
    insertReturns?: TaskAssignment | null;
  } = {},
) => {
  const tasksRepo = {
    create: jest.fn(async (data: Partial<Task>) =>
      baseTask({ id: 'child-1', ...data, status: data.status ?? 'pending' }),
    ),
    incrementCounter: jest.fn(async () => undefined),
  } as unknown as TasksRepository;

  const assignmentsRepo = {
    listActiveForTask: jest.fn(async () => overrides.active ?? []),
    insertIfMissing: jest.fn(async (data: Record<string, unknown>) =>
      overrides.insertReturns === null
        ? null
        : ({
            id: 'a-new',
            taskId: data.taskId,
            assigneeId: data.assigneeId,
          } as unknown as TaskAssignment),
    ),
  } as unknown as TaskAssignmentsRepository;

  const eventsRepo = {
    create: jest.fn(async () => undefined),
  } as unknown as TaskEventsRepository;

  const svc = new RecurringTasksService(tasksRepo, assignmentsRepo, eventsRepo, buildLogger());
  return { svc, tasksRepo, assignmentsRepo, eventsRepo };
};

describe('RecurringTasksService.spawnNextOccurrence', () => {
  it('returns null when parent is not recurring', async () => {
    const { svc, tasksRepo } = buildSvc();
    const out = await svc.spawnNextOccurrence(baseTask({ isRecurring: false }), ACTOR, {} as never);
    expect(out).toBeNull();
    expect(tasksRepo.create as jest.Mock).not.toHaveBeenCalled();
  });

  it('returns null when recurrencePattern is malformed', async () => {
    const { svc } = buildSvc();
    const out = await svc.spawnNextOccurrence(
      baseTask({ recurrencePattern: { not: 'valid' } as Record<string, unknown> }),
      ACTOR,
      {} as never,
    );
    expect(out).toBeNull();
  });

  it('returns null when occurrence cap reached', async () => {
    const { svc } = buildSvc();
    const out = await svc.spawnNextOccurrence(
      baseTask({
        recurrencePattern: { type: 'daily', interval: 1, occurrences: 3 },
        recurrenceOccurrenceCount: 3,
      }),
      ACTOR,
      {} as never,
    );
    expect(out).toBeNull();
  });

  it('creates child with correct due date and parentTaskId', async () => {
    const { svc, tasksRepo } = buildSvc();
    const out = await svc.spawnNextOccurrence(baseTask(), ACTOR, {} as never);
    expect(out?.id).toBe('child-1');
    const payload = (tasksRepo.create as jest.Mock).mock.calls[0][0];
    expect(payload.parentTaskId).toBe(TASK_ID);
    expect(payload.status).toBe('pending');
    expect(payload.isRecurring).toBe(false);
    expect(payload.dueDate).toEqual(new Date('2026-06-02T10:00:00Z'));
  });

  it('copies active assignments forward and bumps counters', async () => {
    const a1 = {
      id: 'a-1',
      taskId: TASK_ID,
      assigneeId: 'staff-1',
      role: 'primary',
    } as unknown as TaskAssignment;
    const a2 = {
      id: 'a-2',
      taskId: TASK_ID,
      assigneeId: 'staff-2',
      role: 'observer',
    } as unknown as TaskAssignment;
    const { svc, tasksRepo, eventsRepo, assignmentsRepo } = buildSvc({
      active: [a1, a2],
    });
    await svc.spawnNextOccurrence(baseTask(), ACTOR, {} as never);
    expect((assignmentsRepo.insertIfMissing as jest.Mock).mock.calls).toHaveLength(2);
    // child assigneeCount += 2, parent recurrenceOccurrenceCount += 1
    const calls = (tasksRepo.incrementCounter as jest.Mock).mock.calls;
    const counters = calls.map((c) => c[1]);
    expect(counters).toContain('assigneeCount');
    expect(counters).toContain('recurrenceOccurrenceCount');
    // event with type=recurrence_spawned on the child
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0].type).toBe('recurrence_spawned');
  });
});
