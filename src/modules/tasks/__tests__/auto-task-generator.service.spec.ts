import { DomainNotFoundException } from '@/common/errors/business.exception';
import { DbService } from '@/db/db.service';
import { LoggerService } from '@/logging/logger.service';
import { ExpiryAlertsRepository } from '@/modules/expiry/repositories/expiry-alerts.repository';
import { AuditLogService } from '@/observability/audit-log.service';

import { TaskEventsRepository } from '../repositories/task-events.repository';
import { TasksRepository } from '../repositories/tasks.repository';
import { AutoTaskGeneratorService } from '../services/auto-task-generator.service';
import { TaskAssignmentService } from '../services/task-assignment.service';
import type { Task } from '../types/task.types';

const TENANT = 'tenant-1';
const ACTOR = 'manager-1';
const STORE = '00000000-0000-0000-0000-000000000aaa';
const ASSIGNEE = '00000000-0000-0000-0000-000000000bbb';
const ALERT_ID = '00000000-0000-0000-0000-000000000ccc';

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
    id: 'task-new',
    tenantId: TENANT,
    storeId: STORE,
    type: 'expiry-check',
    priority: 'urgent',
    status: 'pending',
    expiryAlertId: ALERT_ID,
    productIds: ['00000000-0000-0000-0000-000000000ddd'],
    metadata: {},
    ...over,
  }) as unknown as Task;

const buildSvc = (
  overrides: {
    alert?: {
      id: string;
      status: string;
      daysRemaining: number;
      quantity: number;
      productId: string;
    } | null;
    existing?: Task | null;
  } = {},
) => {
  const tasksRepo = {
    findByExpiryAlert: jest.fn(async () => overrides.existing ?? null),
    create: jest.fn(async (data: Partial<Task>) =>
      baseTask({ ...data, id: 'task-new' } as Partial<Task>),
    ),
  } as unknown as TasksRepository;

  const eventsRepo = {
    create: jest.fn(async () => undefined),
  } as unknown as TaskEventsRepository;

  const assignments = {
    assignBatch: jest.fn(async () => []),
  } as unknown as TaskAssignmentService;

  const alertsRepo = {
    findByIdInTenant: jest.fn(async () => overrides.alert ?? null),
  } as unknown as ExpiryAlertsRepository;

  const svc = new AutoTaskGeneratorService(
    dbThatRunsCallback(),
    tasksRepo,
    eventsRepo,
    assignments,
    alertsRepo,
    buildAudit(),
    buildLogger(),
  );
  return { svc, tasksRepo, eventsRepo, assignments };
};

describe('AutoTaskGeneratorService.generateForAlert', () => {
  it('throws when alert missing in tenant', async () => {
    const { svc } = buildSvc({ alert: null });
    await expect(
      svc.generateForAlert(TENANT, ACTOR, {
        alertId: ALERT_ID,
        storeId: STORE,
        assigneeIds: [ASSIGNEE],
        dueOffsetMinutes: 60,
      }),
    ).rejects.toBeInstanceOf(DomainNotFoundException);
  });

  it('returns the existing task when one is already linked (idempotent)', async () => {
    const existing = baseTask({ id: 'existing-1' });
    const { svc, tasksRepo, assignments } = buildSvc({
      alert: {
        id: ALERT_ID,
        status: 'red',
        daysRemaining: 1,
        quantity: 5,
        productId: '00000000-0000-0000-0000-000000000ddd',
      },
      existing,
    });
    const out = await svc.generateForAlert(TENANT, ACTOR, {
      alertId: ALERT_ID,
      storeId: STORE,
      assigneeIds: [ASSIGNEE],
      dueOffsetMinutes: 60,
    });
    expect(out).toBe(existing);
    expect(tasksRepo.create as jest.Mock).not.toHaveBeenCalled();
    expect(assignments.assignBatch as jest.Mock).not.toHaveBeenCalled();
  });

  it('maps yellow alerts to high priority', async () => {
    const { svc, tasksRepo } = buildSvc({
      alert: {
        id: ALERT_ID,
        status: 'yellow',
        daysRemaining: 10,
        quantity: 3,
        productId: '00000000-0000-0000-0000-000000000ddd',
      },
    });
    await svc.generateForAlert(TENANT, ACTOR, {
      alertId: ALERT_ID,
      storeId: STORE,
      assigneeIds: [ASSIGNEE],
      dueOffsetMinutes: 60 * 24,
    });
    const payload = (tasksRepo.create as jest.Mock).mock.calls[0][0];
    expect(payload.priority).toBe('high');
    expect(payload.type).toBe('expiry-check');
    expect(payload.expiryAlertId).toBe(ALERT_ID);
    expect(payload.requiresScan).toBe(true);
    expect(payload.minimumEvidenceCount).toBe(1);
  });

  it('maps red alerts to urgent priority and assigns to staff', async () => {
    const { svc, tasksRepo, assignments } = buildSvc({
      alert: {
        id: ALERT_ID,
        status: 'red',
        daysRemaining: 1,
        quantity: 7,
        productId: '00000000-0000-0000-0000-000000000ddd',
      },
    });
    await svc.generateForAlert(TENANT, ACTOR, {
      alertId: ALERT_ID,
      storeId: STORE,
      assigneeIds: [ASSIGNEE, '00000000-0000-0000-0000-000000000eee'],
      dueOffsetMinutes: 60,
    });
    const payload = (tasksRepo.create as jest.Mock).mock.calls[0][0];
    expect(payload.priority).toBe('urgent');
    expect(payload.metadata).toMatchObject({
      generator: 'expiry-alert',
      alertStatus: 'red',
      quantity: 7,
    });
    expect((assignments.assignBatch as jest.Mock).mock.calls[0][1]).toEqual([
      ASSIGNEE,
      '00000000-0000-0000-0000-000000000eee',
    ]);
  });
});
