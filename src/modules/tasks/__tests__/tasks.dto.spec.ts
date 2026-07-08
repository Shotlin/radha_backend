import {
  AddEvidenceSchema,
  AutoTaskFromAlertSchema,
  CompleteTaskSchema,
  CreateTaskSchema,
  ListTasksQuerySchema,
  ReassignTaskSchema,
  RecurrencePatternSchema,
  UpdateTaskSchema,
} from '../dto/tasks.dto';

const UUID = '00000000-0000-0000-0000-000000000001';
const STORE = '00000000-0000-0000-0000-000000000002';
const STAFF1 = '00000000-0000-0000-0000-000000000003';
const STAFF2 = '00000000-0000-0000-0000-000000000004';

describe('CreateTaskSchema', () => {
  const valid = {
    title: 'Check expiries',
    type: 'expiry-check',
    storeId: STORE,
    assigneeIds: [STAFF1],
  };

  it('accepts a minimal valid payload and applies defaults', () => {
    const out = CreateTaskSchema.parse(valid);
    expect(out.priority).toBe('medium');
    expect(out.requiresPhoto).toBe(false);
    expect(out.requiresScan).toBe(false);
    expect(out.minimumEvidenceCount).toBe(0);
    expect(out.isRecurring).toBe(false);
  });

  it('rejects empty assigneeIds', () => {
    expect(() => CreateTaskSchema.parse({ ...valid, assigneeIds: [] })).toThrow();
  });

  it('rejects duplicate assigneeIds', () => {
    expect(() => CreateTaskSchema.parse({ ...valid, assigneeIds: [STAFF1, STAFF1] })).toThrow(
      /unique/,
    );
  });

  it('rejects start > due', () => {
    expect(() =>
      CreateTaskSchema.parse({
        ...valid,
        startDate: '2026-12-31',
        dueDate: '2026-01-01',
      }),
    ).toThrow(/before dueDate/);
  });

  it('requires recurrencePattern when isRecurring=true', () => {
    expect(() => CreateTaskSchema.parse({ ...valid, isRecurring: true })).toThrow(
      /recurrencePattern is required/,
    );
  });

  it('requires minimumEvidenceCount >= 1 when requiresPhoto=true', () => {
    expect(() => CreateTaskSchema.parse({ ...valid, requiresPhoto: true })).toThrow(
      /minimumEvidenceCount/,
    );
  });

  it('rejects empty title', () => {
    expect(() => CreateTaskSchema.parse({ ...valid, title: '   ' })).toThrow();
  });

  it('caps assigneeIds at 20', () => {
    const many = Array.from(
      { length: 21 },
      (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    );
    expect(() => CreateTaskSchema.parse({ ...valid, assigneeIds: many })).toThrow();
  });
});

describe('UpdateTaskSchema', () => {
  it('accepts partial updates', () => {
    expect(() => UpdateTaskSchema.parse({ title: 'New' })).not.toThrow();
    expect(() =>
      UpdateTaskSchema.parse({ priority: 'urgent', minimumEvidenceCount: 3 }),
    ).not.toThrow();
  });

  it('rejects invalid date ordering', () => {
    expect(() =>
      UpdateTaskSchema.parse({
        startDate: '2026-12-31',
        dueDate: '2026-01-01',
      }),
    ).toThrow();
  });
});

describe('CompleteTaskSchema', () => {
  it('accepts an empty completion (status-only)', () => {
    const out = CompleteTaskSchema.parse({});
    expect(out.evidence).toBeUndefined();
  });

  it('accepts notes + scanSessionId', () => {
    const out = CompleteTaskSchema.parse({
      notes: 'done',
      scanSessionId: UUID,
    });
    expect(out.scanSessionId).toBe(UUID);
  });
});

describe('ReassignTaskSchema', () => {
  it('defaults role to primary and replace to true', () => {
    const out = ReassignTaskSchema.parse({ assigneeIds: [STAFF1] });
    expect(out.role).toBe('primary');
    expect(out.replace).toBe(true);
  });

  it('rejects duplicate assignees', () => {
    expect(() => ReassignTaskSchema.parse({ assigneeIds: [STAFF1, STAFF1] })).toThrow(/unique/);
  });
});

describe('AddEvidenceSchema', () => {
  it('rejects photo without mediaId', () => {
    expect(() => AddEvidenceSchema.parse({ type: 'photo' })).toThrow();
  });

  it('accepts photo with mediaId', () => {
    expect(() => AddEvidenceSchema.parse({ type: 'photo', mediaId: UUID })).not.toThrow();
  });

  it('rejects scan without scanSessionId', () => {
    expect(() => AddEvidenceSchema.parse({ type: 'scan' })).toThrow();
  });

  it('rejects note without note text', () => {
    expect(() => AddEvidenceSchema.parse({ type: 'note' })).toThrow();
  });

  it('accepts video with mediaId', () => {
    expect(() => AddEvidenceSchema.parse({ type: 'video', mediaId: UUID })).not.toThrow();
  });
});

describe('RecurrencePatternSchema', () => {
  it('accepts daily with default interval=1', () => {
    const out = RecurrencePatternSchema.parse({ type: 'daily' });
    expect(out.interval).toBe(1);
  });

  it('rejects weekly with empty daysOfWeek list', () => {
    expect(() => RecurrencePatternSchema.parse({ type: 'weekly', daysOfWeek: [] })).toThrow();
  });

  it('rejects out-of-range dayOfMonth', () => {
    expect(() => RecurrencePatternSchema.parse({ type: 'monthly', dayOfMonth: 32 })).toThrow();
  });
});

describe('ListTasksQuerySchema', () => {
  it('parses CSV status into deduped array', () => {
    const out = ListTasksQuerySchema.parse({ status: 'pending,completed,Pending' });
    expect(out.status).toEqual(['pending', 'completed', 'pending']);
  });

  it('drops unknown statuses silently', () => {
    const out = ListTasksQuerySchema.parse({ status: 'foo,pending' });
    expect(out.status).toEqual(['pending']);
  });

  it('caps limit at 200', () => {
    expect(() => ListTasksQuerySchema.parse({ limit: 9999 })).toThrow();
  });

  it('defaults limit to 50', () => {
    const out = ListTasksQuerySchema.parse({});
    expect(out.limit).toBe(50);
  });
});

describe('AutoTaskFromAlertSchema', () => {
  it('defaults dueOffsetMinutes to 24h', () => {
    const out = AutoTaskFromAlertSchema.parse({
      alertId: UUID,
      storeId: STORE,
      assigneeIds: [STAFF1, STAFF2],
    });
    expect(out.dueOffsetMinutes).toBe(60 * 24);
  });

  it('rejects empty assigneeIds', () => {
    expect(() =>
      AutoTaskFromAlertSchema.parse({
        alertId: UUID,
        storeId: STORE,
        assigneeIds: [],
      }),
    ).toThrow();
  });
});
