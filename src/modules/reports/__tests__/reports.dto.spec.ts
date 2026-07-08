import {
  AdHocExportBodySchema,
  DownloadByFormatParamSchema,
  DownloadQuerySchema,
  ExportExistingReportBodySchema,
  ListReportFilesQuerySchema,
} from '../dto/reports.dto';

describe('AdHocExportBodySchema', () => {
  const valid = {
    title: 'Q1 Report',
    formats: ['xlsx', 'csv'] as const,
    rows: [{ a: 1 }],
    tenantName: 'Acme',
  };

  it('accepts a minimal valid payload', () => {
    expect(() => AdHocExportBodySchema.parse(valid)).not.toThrow();
  });

  it('rejects an empty formats array', () => {
    expect(() => AdHocExportBodySchema.parse({ ...valid, formats: [] })).toThrow();
  });

  it('rejects unknown formats', () => {
    expect(() => AdHocExportBodySchema.parse({ ...valid, formats: ['html'] })).toThrow();
  });

  it('rejects when dateTo is before dateFrom', () => {
    expect(() =>
      AdHocExportBodySchema.parse({
        ...valid,
        dateFrom: '2026-02-01T00:00:00Z',
        dateTo: '2026-01-01T00:00:00Z',
      }),
    ).toThrow();
  });

  it('caps row count at 100k', () => {
    const huge = Array.from({ length: 100_001 }, () => ({ a: 1 }));
    expect(() => AdHocExportBodySchema.parse({ ...valid, rows: huge })).toThrow();
  });

  it('coerces date strings into Date objects', () => {
    const parsed = AdHocExportBodySchema.parse({
      ...valid,
      dateFrom: '2026-01-01T00:00:00Z',
      dateTo: '2026-02-01T00:00:00Z',
    });
    expect(parsed.dateFrom).toBeInstanceOf(Date);
    expect(parsed.dateTo).toBeInstanceOf(Date);
  });
});

describe('ExportExistingReportBodySchema', () => {
  it('accepts a minimal valid payload', () => {
    expect(() => ExportExistingReportBodySchema.parse({ formats: ['xlsx'] })).not.toThrow();
  });

  it('rejects an empty formats array', () => {
    expect(() => ExportExistingReportBodySchema.parse({ formats: [] })).toThrow();
  });
});

describe('DownloadQuerySchema', () => {
  it('defaults expirySeconds to 24h when omitted', () => {
    const parsed = DownloadQuerySchema.parse({});
    expect(parsed.expirySeconds).toBe(24 * 3600);
  });

  it('rejects expirySeconds below the floor', () => {
    expect(() => DownloadQuerySchema.parse({ expirySeconds: 30 })).toThrow();
  });

  it('rejects expirySeconds above the 7-day cap', () => {
    expect(() => DownloadQuerySchema.parse({ expirySeconds: 14 * 24 * 3600 })).toThrow();
  });
});

describe('DownloadByFormatParamSchema', () => {
  it('accepts known formats', () => {
    for (const f of ['pdf', 'xlsx', 'csv', 'json']) {
      expect(() => DownloadByFormatParamSchema.parse({ format: f })).not.toThrow();
    }
  });

  it('rejects unknown formats', () => {
    expect(() => DownloadByFormatParamSchema.parse({ format: 'html' })).toThrow();
  });
});

describe('ListReportFilesQuerySchema', () => {
  it('requires a UUID reportId', () => {
    expect(() => ListReportFilesQuerySchema.parse({ reportId: 'not-a-uuid' })).toThrow();
  });

  it('accepts a valid UUID', () => {
    const parsed = ListReportFilesQuerySchema.parse({
      reportId: '00000000-0000-4000-8000-000000000001',
    });
    expect(parsed.reportId).toBe('00000000-0000-4000-8000-000000000001');
  });
});
