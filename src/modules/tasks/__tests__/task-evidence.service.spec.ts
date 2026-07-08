import {
  BusinessException,
  DomainForbiddenException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';

import type { AddEvidenceDto } from '../dto/tasks.dto';
import { TaskEventsRepository } from '../repositories/task-events.repository';
import { TaskEvidenceRepository } from '../repositories/task-evidence.repository';
import { TasksRepository } from '../repositories/tasks.repository';
import { TaskEvidenceService } from '../services/task-evidence.service';
import type { Task, TaskEvidence } from '../types/task.types';

const TENANT = 'tenant-1';
const ACTOR = 'user-1';

const baseTask = (over: Partial<Task> = {}): Task =>
  ({
    id: 'task-1',
    tenantId: TENANT,
    storeId: 'store-1',
    title: 't',
    type: 'shelf-audit',
    priority: 'medium',
    status: 'in_progress',
    requiresPhoto: false,
    requiresScan: false,
    minimumEvidenceCount: 0,
    productIds: [],
    isRecurring: false,
    evidenceCount: 0,
    assigneeCount: 1,
    recurrenceOccurrenceCount: 0,
    metadata: {},
    ...over,
  }) as unknown as Task;

const evidenceRow = (over: Partial<TaskEvidence> = {}): TaskEvidence =>
  ({
    id: 'ev-1',
    taskId: 'task-1',
    tenantId: TENANT,
    type: 'note',
    note: 'hi',
    addedBy: ACTOR,
    deletedAt: null,
    metadata: {},
    ...over,
  }) as unknown as TaskEvidence;

const buildSvc = (overrides: { existing?: TaskEvidence | null } = {}) => {
  const evidenceRepo = {
    create: jest.fn(async (data: Record<string, unknown>) =>
      evidenceRow({ id: 'ev-new', ...data } as Partial<TaskEvidence>),
    ),
    findByIdInTenant: jest.fn(async () => overrides.existing ?? null),
    listForTask: jest.fn(async () => []),
    softDelete: jest.fn(async () => undefined),
  } as unknown as TaskEvidenceRepository;

  const tasksRepo = {
    incrementCounter: jest.fn(async () => undefined),
  } as unknown as TasksRepository;

  const eventsRepo = {
    create: jest.fn(async () => undefined),
  } as unknown as TaskEventsRepository;

  const svc = new TaskEvidenceService(evidenceRepo, tasksRepo, eventsRepo);
  return { svc, evidenceRepo, tasksRepo, eventsRepo };
};

describe('TaskEvidenceService.add', () => {
  it('persists row, bumps evidenceCount, logs event', async () => {
    const { svc, evidenceRepo, tasksRepo, eventsRepo } = buildSvc();
    const dto: AddEvidenceDto = {
      type: 'photo',
      mediaId: '00000000-0000-0000-0000-000000000001',
    };
    const out = await svc.add(baseTask(), dto, ACTOR, {} as never);
    expect(out.id).toBe('ev-new');
    expect((evidenceRepo.create as jest.Mock).mock.calls[0][0]).toMatchObject({
      taskId: 'task-1',
      type: 'photo',
      mediaId: '00000000-0000-0000-0000-000000000001',
      addedBy: ACTOR,
    });
    expect((tasksRepo.incrementCounter as jest.Mock).mock.calls[0]).toEqual([
      'task-1',
      'evidenceCount',
      1,
      {},
    ]);
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0].type).toBe('evidence_added');
  });
});

describe('TaskEvidenceService.remove', () => {
  it('throws when evidence missing', async () => {
    const { svc } = buildSvc({ existing: null });
    await expect(svc.remove(TENANT, ACTOR, 'ev-1')).rejects.toBeInstanceOf(DomainNotFoundException);
  });

  it('forbids removal by a different user', async () => {
    const { svc } = buildSvc({
      existing: evidenceRow({ addedBy: 'other-user' }),
    });
    await expect(svc.remove(TENANT, ACTOR, 'ev-1')).rejects.toBeInstanceOf(
      DomainForbiddenException,
    );
  });

  it('soft-deletes and decrements counter', async () => {
    const { svc, evidenceRepo, tasksRepo, eventsRepo } = buildSvc({
      existing: evidenceRow(),
    });
    await svc.remove(TENANT, ACTOR, 'ev-1');
    expect(evidenceRepo.softDelete as jest.Mock).toHaveBeenCalledWith('ev-1', ACTOR);
    expect((tasksRepo.incrementCounter as jest.Mock).mock.calls[0]).toEqual([
      'task-1',
      'evidenceCount',
      -1,
    ]);
    expect((eventsRepo.create as jest.Mock).mock.calls[0][0].type).toBe('evidence_removed');
  });
});

describe('TaskEvidenceService.ensureRequirementsMet', () => {
  const { svc } = buildSvc();

  it('passes when no requirements set', () => {
    expect(() =>
      svc.ensureRequirementsMet({
        task: baseTask(),
        existingEvidence: [],
        incomingEvidence: [],
        completionScanSessionId: undefined,
      }),
    ).not.toThrow();
  });

  it('rejects when minimum evidence count not met', () => {
    expect(() =>
      svc.ensureRequirementsMet({
        task: baseTask({ minimumEvidenceCount: 2 }),
        existingEvidence: [evidenceRow()],
        incomingEvidence: [],
        completionScanSessionId: undefined,
      }),
    ).toThrow(BusinessException);
  });

  it('counts incoming evidence toward the minimum', () => {
    expect(() =>
      svc.ensureRequirementsMet({
        task: baseTask({ minimumEvidenceCount: 2 }),
        existingEvidence: [evidenceRow()],
        incomingEvidence: [{ type: 'note', note: 'fresh' }],
        completionScanSessionId: undefined,
      }),
    ).not.toThrow();
  });

  it('rejects when requiresPhoto but no photo evidence', () => {
    expect(() =>
      svc.ensureRequirementsMet({
        task: baseTask({ requiresPhoto: true, minimumEvidenceCount: 1 }),
        existingEvidence: [evidenceRow()],
        incomingEvidence: [],
        completionScanSessionId: undefined,
      }),
    ).toThrow(/photo/);
  });

  it('accepts existing photo evidence', () => {
    expect(() =>
      svc.ensureRequirementsMet({
        task: baseTask({ requiresPhoto: true, minimumEvidenceCount: 1 }),
        existingEvidence: [
          evidenceRow({ type: 'photo', mediaId: '00000000-0000-0000-0000-000000000099' }),
        ],
        incomingEvidence: [],
        completionScanSessionId: undefined,
      }),
    ).not.toThrow();
  });

  it('rejects when requiresScan and no scan evidence/inline session', () => {
    expect(() =>
      svc.ensureRequirementsMet({
        task: baseTask({ requiresScan: true }),
        existingEvidence: [],
        incomingEvidence: [],
        completionScanSessionId: undefined,
      }),
    ).toThrow(/scan/);
  });

  it('accepts inline completion scanSessionId', () => {
    expect(() =>
      svc.ensureRequirementsMet({
        task: baseTask({ requiresScan: true }),
        existingEvidence: [],
        incomingEvidence: [],
        completionScanSessionId: '00000000-0000-0000-0000-000000000123',
      }),
    ).not.toThrow();
  });

  it('accepts pre-existing scan-session evidence', () => {
    expect(() =>
      svc.ensureRequirementsMet({
        task: baseTask({ requiresScan: true }),
        existingEvidence: [
          evidenceRow({
            type: 'scan',
            scanSessionId: '00000000-0000-0000-0000-000000000123',
          }),
        ],
        incomingEvidence: [],
        completionScanSessionId: undefined,
      }),
    ).not.toThrow();
  });
});
