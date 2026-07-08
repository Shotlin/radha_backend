import { LeadsService } from '../services/leads.service';
import type { CreateLeadInput } from '../types/lead.types';

const baseLeadRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'L1',
  name: 'Alice',
  email: 'alice@example.com',
  mobile: null,
  company: null,
  message: null,
  source: 'contact_form',
  status: 'new',
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  pageUrl: null,
  referrer: null,
  contactedAt: null,
  contactedBy: null,
  demoScheduledAt: null,
  convertedAt: null,
  convertedTenantId: null,
  lostAt: null,
  lostReason: null,
  notes: null,
  assignedTo: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  createdBy: null,
  updatedBy: null,
  deletedBy: null,
  metadata: {},
  ...overrides,
});

const buildSvc = (
  opts: {
    findActiveByEmailRecent?: jest.Mock;
    findById?: jest.Mock;
    notifications?: { send: jest.Mock };
    audit?: { logAction: jest.Mock };
  } = {},
) => {
  const stored: Record<string, Record<string, unknown>> = {};
  let counter = 0;
  const repo = {
    create: jest.fn(async (data: Record<string, unknown>) => {
      counter += 1;
      const id = `L${counter}`;
      stored[id] = baseLeadRow({ id, ...data });
      return stored[id];
    }),
    update: jest.fn(async (id: string, patch: Record<string, unknown>) => {
      stored[id] = { ...(stored[id] ?? baseLeadRow({ id })), ...patch };
      return stored[id];
    }),
    findById: opts.findById ?? jest.fn(async (id: string) => stored[id] ?? null),
    findActiveByEmailRecent: opts.findActiveByEmailRecent ?? jest.fn(async () => null),
    listPaginated: jest.fn(async () => ({
      data: Object.values(stored),
      nextCursor: null,
      hasMore: false,
    })),
    getConversionStats: jest.fn(async () => ({
      totalLeads: 10,
      contacted: 7,
      qualified: 5,
      converted: 2,
      lost: 1,
      spam: 1,
    })),
  } as unknown as ConstructorParameters<typeof LeadsService>[0];
  const config = {} as unknown as ConstructorParameters<typeof LeadsService>[1];
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as ConstructorParameters<typeof LeadsService>[2];
  const audit = (opts.audit ?? {
    logAction: jest.fn(async () => undefined),
  }) as unknown as ConstructorParameters<typeof LeadsService>[3];
  const notifications =
    (opts.notifications as unknown as ConstructorParameters<typeof LeadsService>[4]) ?? undefined;
  return {
    svc: new LeadsService(repo, config, logger, audit, notifications),
    repo: repo as unknown as Record<string, jest.Mock>,
    audit: audit as unknown as { logAction: jest.Mock },
    stored,
  };
};

const baseDto: CreateLeadInput = {
  name: 'Alice Doe',
  email: 'alice@business.com',
  source: 'contact_form',
};

describe('LeadsService.createLead', () => {
  beforeEach(() => {
    delete process.env.OWNER_EMAIL;
  });

  it('creates a valid lead with status=new', async () => {
    const { svc, repo } = buildSvc();
    const lead = await svc.createLead(baseDto);
    expect(lead.status).toBe('new');
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('flags spam by content pattern', async () => {
    const { svc } = buildSvc();
    const lead = await svc.createLead({
      ...baseDto,
      message: 'Click here to BUY VIAGRA cheap!',
    });
    expect(lead.status).toBe('spam');
  });

  it('flags spam by disposable email domain', async () => {
    const { svc } = buildSvc();
    const lead = await svc.createLead({
      ...baseDto,
      email: 'someone@mailinator.com',
    });
    expect(lead.status).toBe('spam');
  });

  it('flags spam when same email submitted recently (duplicate window)', async () => {
    const { svc } = buildSvc({
      findActiveByEmailRecent: jest.fn(async () => baseLeadRow()),
    });
    const lead = await svc.createLead(baseDto);
    expect(lead.status).toBe('spam');
  });

  it('redacts PII from metadata before persistence', async () => {
    const { svc, repo } = buildSvc();
    await svc.createLead({
      ...baseDto,
      metadata: {
        anotherEmail: 'leak@bad.com',
        free: 'PAN ABCDE1234F shows up',
      },
    });
    const created = repo.create.mock.calls[0][0] as Record<string, unknown>;
    const meta = created.metadata as Record<string, unknown>;
    expect(meta.anotherEmail).toBe('[REDACTED]');
    expect(String(meta.free)).toContain('[REDACTED]');
  });

  it('does not call notifications when OWNER_EMAIL is unset', async () => {
    const send = jest.fn(async () => ({}));
    const { svc } = buildSvc({ notifications: { send } });
    await svc.createLead(baseDto);
    expect(send).not.toHaveBeenCalled();
  });

  it('calls notifications when OWNER_EMAIL is set and lead is not spam', async () => {
    process.env.OWNER_EMAIL = 'owner@radha.in';
    const send: jest.Mock = jest.fn(async (_dto: Record<string, unknown>) => ({}));
    const { svc } = buildSvc({ notifications: { send } });
    await svc.createLead(baseDto);
    expect(send).toHaveBeenCalledTimes(1);
    const calls = send.mock.calls as Array<Array<Record<string, unknown>>>;
    const arg = calls[0][0];
    expect((arg.data as Record<string, unknown>).template).toBe('new-lead');
  });

  it('does NOT call notifications for spam leads', async () => {
    process.env.OWNER_EMAIL = 'owner@radha.in';
    const send = jest.fn(async () => ({}));
    const { svc } = buildSvc({ notifications: { send } });
    await svc.createLead({ ...baseDto, email: 'someone@mailinator.com' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('LeadsService.updateStatus', () => {
  it('audits a status transition and stamps contactedAt', async () => {
    const audit = { logAction: jest.fn(async () => undefined) };
    const { svc, stored } = buildSvc({ audit });
    const created = await svc.createLead(baseDto);
    const updated = await svc.updateStatus(created.id, 'contacted', 'spoke today', 'user-1');
    expect(updated.status).toBe('contacted');
    expect(stored[created.id].contactedAt).toBeInstanceOf(Date);
    expect(audit.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE',
        resourceType: 'marketing_lead',
        resourceId: created.id,
        metadata: expect.objectContaining({ fromStatus: 'new', toStatus: 'contacted' }),
      }),
    );
  });

  it('throws when lead is missing', async () => {
    const { svc } = buildSvc();
    await expect(
      svc.updateStatus('00000000-0000-0000-0000-000000000000', 'qualified', undefined, 'u'),
    ).rejects.toThrow(/not found/);
  });
});

describe('LeadsService.list', () => {
  it('delegates pagination filters to the repo', async () => {
    const { svc, repo } = buildSvc();
    await svc.createLead(baseDto);
    const out = await svc.list({ status: 'new', limit: 10 });
    expect(out.hasMore).toBe(false);
    expect(repo.listPaginated).toHaveBeenCalledWith({ status: 'new', limit: 10 });
  });
});

describe('LeadsService.convert', () => {
  it('marks lead converted with audit', async () => {
    const audit = { logAction: jest.fn(async () => undefined) };
    const { svc } = buildSvc({ audit });
    const created = await svc.createLead(baseDto);
    const converted = await svc.convert(
      created.id,
      '11111111-1111-1111-1111-111111111111',
      'user-1',
    );
    expect(converted.status).toBe('converted');
    expect(converted.convertedTenantId).toBe('11111111-1111-1111-1111-111111111111');
    expect(audit.logAction).toHaveBeenCalledTimes(1);
  });
});

describe('LeadsService.getConversionRate', () => {
  it('computes percentages from totals', async () => {
    const { svc } = buildSvc();
    const stats = await svc.getConversionRate({
      from: new Date('2026-01-01'),
      to: new Date('2026-01-31'),
    });
    expect(stats.totalLeads).toBe(10);
    expect(stats.contactRate).toBe(70);
    expect(stats.qualificationRate).toBe(50);
    expect(stats.conversionRate).toBe(20);
  });
});
