import {
  DomainForbiddenException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';
import { LoggerService } from '@/logging/logger.service';

import { TaskAssignmentsRepository } from '../repositories/task-assignments.repository';
import { TaskEventsRepository } from '../repositories/task-events.repository';
import { TasksRepository } from '../repositories/tasks.repository';
import { TaskAssignmentService } from '../services/task-assignment.service';
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
    status: 'pending',
    assigneeCount: 0,
    ...over,
  }) as unknown as Task;

const baseAssignment = (over: Partial<TaskAssignment> = {}): TaskAssignment =>
  ({
    id: 'assn-1',
    taskId: TASK_ID,
    tenantId: TENANT,
    role: 'primary',
    assigneeId: 'staff-1',
    assignedBy: ACTOR,
    revokedAt: null,
    ...over,
  }) as unknown as TaskAssignment;

const buildSvc = (
  overrides: {
    insertReturns?: TaskAssignment | null;
    active?: TaskAssignment | null;
    revokedSingle?: TaskAssignment | null;
    revokedCount?: number;
  } = {},
) => {
  const assignmentsRepo = {
    insertIfMissing: jest.fn(async (data: Record<string, unknown>) =>
      overrides.insertReturns === null
        ? null
        : (overrides.insertReturns ?? baseAssignment({ assigneeId: data.assigneeId as string })),
    ),
    findActiveByTaskAndUser: jest.fn(async () => overrides.active ?? null),
    listActiveForTask: jest.fn(async () => []),
    revoke: jest.fn(async () => overrides.revokedSingle ?? null),
    revokeAllPrimary: jest.fn(async () => overrides.revokedCount ?? 0),
  } as unknown as TaskAssignmentsRepository;

  const eventsRepo = {
    create: jest.fn(async () => undefined),
  } as unknown as TaskEventsRepository;

  const tasksRepo = {
    incrementCounter: jest.fn(async () => undefined),
  } as unknown as TasksRepository;

  const svc = new TaskAssignmentService(assignmentsRepo, eventsRepo, tasksRepo, buildLogger());
  return { svc, assignmentsRepo, eventsRepo, tasksRepo };
};

describe('TaskAssignmentService.assignBatch', () => {
  it('inserts each assignee, dedupes within the call, increments counter', async () => {
    const { svc, assignmentsRepo, tasksRepo, eventsRepo } = buildSvc();
    const created = await svc.assignBatch(
      baseTask(),
      ['s-1', 's-2', 's-1'],
      'primary',
      ACTOR,
      {} as never,
    );
    expect(created).toHaveLength(2);
    expect((assignmentsRepo.insertIfMissing as jest.Mock).mock.calls).toHaveLength(2);
    expect((tasksRepo.incrementCounter as jest.Mock).mock.calls[0]).toEqual([
      TASK_ID,
      'assigneeCount',
      2,
      {},
    ]);
    expect((eventsRepo.create as jest.Mock).mock.calls).toHaveLength(2);
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0].type).toBe('assigned');
  });

  it('does not bump counter when every insert is a no-op (already-active rows)', async () => {
    const { svc, tasksRepo } = buildSvc({ insertReturns: null });
    const created = await svc.assignBatch(baseTask(), ['s-1'], 'primary', ACTOR, {} as never);
    expect(created).toHaveLength(0);
    expect(tasksRepo.incrementCounter as jest.Mock).not.toHaveBeenCalled();
  });
});

describe('TaskAssignmentService.reassign', () => {
  it('replaces primary set when replace=true', async () => {
    const { svc, assignmentsRepo, tasksRepo, eventsRepo } = buildSvc({
      revokedCount: 2,
    });
    const result = await svc.reassign(
      baseTask({ assigneeCount: 2 }),
      ['s-3'],
      'primary',
      ACTOR,
      { reason: 'rotation', replace: true },
      {} as never,
    );
    expect(result.revokedCount).toBe(2);
    expect(result.addedAssignments).toHaveLength(1);
    expect(assignmentsRepo.revokeAllPrimary as jest.Mock).toHaveBeenCalledWith(
      TASK_ID,
      ACTOR,
      'rotation',
      {},
    );
    // counter goes -2 then +1
    const calls = (tasksRepo.incrementCounter as jest.Mock).mock.calls;
    expect(calls[0]).toEqual([TASK_ID, 'assigneeCount', -2, {}]);
    expect(calls[1]).toEqual([TASK_ID, 'assigneeCount', 1, {}]);
    expect((eventsRepo.create as jest.Mock).mock.calls.at(-1)[0].type).toBe('reassigned');
  });

  it('does not revoke when replace=false', async () => {
    const { svc, assignmentsRepo } = buildSvc();
    await svc.reassign(baseTask(), ['s-3'], 'observer', ACTOR, { replace: false }, {} as never);
    expect(assignmentsRepo.revokeAllPrimary as jest.Mock).not.toHaveBeenCalled();
  });
});

describe('TaskAssignmentService.unassign', () => {
  it('throws when no active assignment exists', async () => {
    const { svc } = buildSvc({ revokedSingle: null });
    await expect(
      svc.unassign(baseTask(), 'staff-1', ACTOR, undefined, {} as never),
    ).rejects.toBeInstanceOf(DomainNotFoundException);
  });

  it('revokes, decrements counter, logs unassigned event', async () => {
    const { svc, tasksRepo, eventsRepo } = buildSvc({
      revokedSingle: baseAssignment({ revokedAt: new Date() }),
    });
    await svc.unassign(baseTask(), 'staff-1', ACTOR, 'left team', {} as never);
    expect((tasksRepo.incrementCounter as jest.Mock).mock.calls[0]).toEqual([
      TASK_ID,
      'assigneeCount',
      -1,
      {},
    ]);
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0].type).toBe('unassigned');
  });
});

describe('TaskAssignmentService.assertActiveAssignment', () => {
  it('throws DomainForbiddenException when not assigned', async () => {
    const { svc } = buildSvc({ active: null });
    await expect(svc.assertActiveAssignment(TASK_ID, 'staff-9')).rejects.toBeInstanceOf(
      DomainForbiddenException,
    );
  });

  it('returns the active assignment when present', async () => {
    const a = baseAssignment();
    const { svc } = buildSvc({ active: a });
    const out = await svc.assertActiveAssignment(TASK_ID, 'staff-1');
    expect(out).toBe(a);
  });
});
