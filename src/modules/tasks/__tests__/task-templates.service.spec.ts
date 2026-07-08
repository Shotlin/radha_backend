import {
  DomainConflictException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';
import { LoggerService } from '@/logging/logger.service';
import { AuditLogService } from '@/observability/audit-log.service';

import type { CreateTemplateDto, InstantiateTemplateDto } from '../dto/tasks.dto';
import { TaskTemplatesRepository } from '../repositories/task-templates.repository';
import { TaskTemplatesService } from '../services/task-templates.service';
import { TasksService } from '../tasks.service';
import type { Task, TaskTemplate } from '../types/task.types';

const TENANT = 'tenant-1';
const ACTOR = 'manager-1';

const buildLogger = (): LoggerService =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const buildAudit = (): AuditLogService =>
  ({ logAction: jest.fn(async () => undefined) }) as unknown as AuditLogService;

const baseTemplate = (over: Partial<TaskTemplate> = {}): TaskTemplate =>
  ({
    id: 'tpl-1',
    tenantId: TENANT,
    name: 'Daily shelf check',
    description: 'desc',
    type: 'shelf-audit',
    priority: 'medium',
    titleTemplate: 'Daily shelf check',
    defaultDueOffsetMinutes: 60 * 24,
    estimatedDurationMinutes: 30,
    requiresPhoto: false,
    requiresScan: false,
    minimumEvidenceCount: 0,
    isRecurring: false,
    recurrencePattern: null,
    isActive: true,
    metadata: {},
    deletedAt: null,
    ...over,
  }) as unknown as TaskTemplate;

const buildSvc = (
  overrides: {
    byName?: TaskTemplate | null;
    byId?: TaskTemplate | null;
  } = {},
) => {
  const repo = {
    create: jest.fn(async (data: Partial<TaskTemplate>) =>
      baseTemplate({ id: 'tpl-new', ...data }),
    ),
    findByIdInTenant: jest.fn(async () => overrides.byId ?? null),
    findByNameInTenant: jest.fn(async () => overrides.byName ?? null),
    listForTenant: jest.fn(async () => []),
    update: jest.fn(async (id: string, data: Partial<TaskTemplate>) =>
      baseTemplate({ ...(overrides.byId ?? {}), ...data, id }),
    ),
    softDelete: jest.fn(async () => undefined),
  } as unknown as TaskTemplatesRepository;

  const tasksService = {
    create: jest.fn(async () => ({ id: 'task-from-tpl' }) as unknown as Task),
  } as unknown as TasksService;

  const svc = new TaskTemplatesService(repo, tasksService, buildAudit(), buildLogger());
  return { svc, repo, tasksService };
};

describe('TaskTemplatesService.create', () => {
  it('rejects duplicate name', async () => {
    const { svc } = buildSvc({ byName: baseTemplate() });
    await expect(
      svc.create(TENANT, ACTOR, {
        name: 'Daily shelf check',
        type: 'shelf-audit',
        titleTemplate: 'Daily shelf check',
        priority: 'medium',
        requiresPhoto: false,
        requiresScan: false,
        minimumEvidenceCount: 0,
        isRecurring: false,
      } as CreateTemplateDto),
    ).rejects.toBeInstanceOf(DomainConflictException);
  });

  it('persists a fresh template', async () => {
    const { svc, repo } = buildSvc();
    const out = await svc.create(TENANT, ACTOR, {
      name: 'Fresh template',
      type: 'cleaning',
      titleTemplate: 'Clean aisle 4',
      priority: 'low',
      requiresPhoto: false,
      requiresScan: false,
      minimumEvidenceCount: 0,
      isRecurring: false,
    } as CreateTemplateDto);
    expect(out.id).toBe('tpl-new');
    const payload = (repo.create as jest.Mock).mock.calls[0][0];
    expect(payload.name).toBe('Fresh template');
  });
});

describe('TaskTemplatesService.findById', () => {
  it('throws when missing', async () => {
    const { svc } = buildSvc({ byId: null });
    await expect(svc.findById(TENANT, 'tpl-1')).rejects.toBeInstanceOf(DomainNotFoundException);
  });

  it('returns the row when present', async () => {
    const t = baseTemplate();
    const { svc } = buildSvc({ byId: t });
    expect(await svc.findById(TENANT, 'tpl-1')).toBe(t);
  });
});

describe('TaskTemplatesService.delete', () => {
  it('soft-deletes when present', async () => {
    const { svc, repo } = buildSvc({ byId: baseTemplate() });
    await svc.delete(TENANT, ACTOR, 'tpl-1');
    expect(repo.softDelete as jest.Mock).toHaveBeenCalledWith('tpl-1', ACTOR);
  });
});

describe('TaskTemplatesService.instantiate', () => {
  it('rejects inactive templates', async () => {
    const { svc } = buildSvc({ byId: baseTemplate({ isActive: false }) });
    await expect(
      svc.instantiate(TENANT, ACTOR, 'tpl-1', {
        storeId: '00000000-0000-0000-0000-0000000000aa',
        assigneeIds: ['00000000-0000-0000-0000-0000000000bb'],
      } as InstantiateTemplateDto),
    ).rejects.toBeInstanceOf(DomainConflictException);
  });

  it('builds a CreateTaskDto from template + overrides and delegates', async () => {
    const tpl = baseTemplate({ defaultDueOffsetMinutes: 60 });
    const { svc, tasksService } = buildSvc({ byId: tpl });
    await svc.instantiate(TENANT, ACTOR, 'tpl-1', {
      storeId: '00000000-0000-0000-0000-0000000000aa',
      assigneeIds: ['00000000-0000-0000-0000-0000000000bb'],
      title: 'Override title',
    } as InstantiateTemplateDto);
    const payload = (tasksService.create as jest.Mock).mock.calls[0][2];
    expect(payload.title).toBe('Override title');
    expect(payload.type).toBe(tpl.type);
    expect(payload.priority).toBe(tpl.priority);
    expect(payload.templateId).toBe(tpl.id);
    expect(payload.metadata.fromTemplate).toBe(tpl.id);
    expect(payload.dueDate).toBeInstanceOf(Date);
  });

  it('falls back to template titleTemplate when no override', async () => {
    const { svc, tasksService } = buildSvc({ byId: baseTemplate() });
    await svc.instantiate(TENANT, ACTOR, 'tpl-1', {
      storeId: '00000000-0000-0000-0000-0000000000aa',
      assigneeIds: ['00000000-0000-0000-0000-0000000000bb'],
    } as InstantiateTemplateDto);
    const payload = (tasksService.create as jest.Mock).mock.calls[0][2];
    expect(payload.title).toBe('Daily shelf check');
  });
});
