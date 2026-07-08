import {
  buildReportKey,
  computeExpiresAt,
  contentTypeFor,
  extensionFor,
  sha256Hex,
} from '../utils/storage-keys.utils';

describe('extensionFor / contentTypeFor', () => {
  it('returns the canonical extension per format', () => {
    expect(extensionFor('xlsx')).toBe('xlsx');
    expect(extensionFor('pdf')).toBe('pdf');
    expect(extensionFor('csv')).toBe('csv');
    expect(extensionFor('json')).toBe('json');
  });

  it('returns IANA-registered MIME types', () => {
    expect(contentTypeFor('xlsx')).toMatch(/spreadsheetml\.sheet/);
    expect(contentTypeFor('pdf')).toBe('application/pdf');
    expect(contentTypeFor('csv')).toMatch(/^text\/csv/);
    expect(contentTypeFor('json')).toMatch(/^application\/json/);
  });
});

describe('buildReportKey', () => {
  const FIXED_NOW = new Date('2026-06-01T12:00:00Z');
  const SEED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('clusters keys by tenant first, then report, then date', () => {
    const built = buildReportKey({
      tenantId: 'tenant-1',
      reportId: 'rep-1',
      format: 'xlsx',
      title: 'Expiry Q1',
      now: FIXED_NOW,
      randomSeed: SEED,
    });
    expect(built.s3Key).toMatch(/^tenants\/tenant-1\/reports\/rep-1\/2026-06-01\//);
    expect(built.s3Key).toMatch(/\.xlsx$/);
  });

  it('embeds a slug derived from the title', () => {
    const built = buildReportKey({
      tenantId: 't1',
      reportId: 'r1',
      format: 'pdf',
      title: 'Expiry — Q1 / 2026',
      now: FIXED_NOW,
      randomSeed: SEED,
    });
    expect(built.s3Key).toMatch(/expiry-q1-2026/);
    expect(built.fileName).toBe('expiry-q1-2026.pdf');
  });

  it('produces unique keys when randomSeed differs', () => {
    const a = buildReportKey({
      tenantId: 't1',
      reportId: 'r1',
      format: 'xlsx',
      title: 'X',
      randomSeed: '11111111-1111-1111-1111-111111111111',
    });
    const b = buildReportKey({
      tenantId: 't1',
      reportId: 'r1',
      format: 'xlsx',
      title: 'X',
      randomSeed: '22222222-2222-2222-2222-222222222222',
    });
    expect(a.s3Key).not.toBe(b.s3Key);
  });

  it('produces deterministic keys for the same seed + clock', () => {
    const a = buildReportKey({
      tenantId: 't1',
      reportId: 'r1',
      format: 'csv',
      title: 'Same',
      randomSeed: SEED,
      now: FIXED_NOW,
    });
    const b = buildReportKey({
      tenantId: 't1',
      reportId: 'r1',
      format: 'csv',
      title: 'Same',
      randomSeed: SEED,
      now: FIXED_NOW,
    });
    expect(a.s3Key).toBe(b.s3Key);
  });

  it('attaches the right content-type on every build', () => {
    const built = buildReportKey({
      tenantId: 't',
      reportId: 'r',
      format: 'pdf',
      title: 'X',
      randomSeed: SEED,
    });
    expect(built.contentType).toBe('application/pdf');
    expect(built.extension).toBe('pdf');
  });
});

describe('sha256Hex', () => {
  it('is deterministic', () => {
    const a = sha256Hex(Buffer.from('hello'));
    const b = sha256Hex(Buffer.from('hello'));
    expect(a).toBe(b);
  });

  it('produces 64-char lowercase hex', () => {
    const h = sha256Hex(Buffer.from('hello'));
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes for different inputs', () => {
    const a = sha256Hex(Buffer.from('hello'));
    const b = sha256Hex(Buffer.from('world'));
    expect(a).not.toBe(b);
  });
});

describe('computeExpiresAt', () => {
  it('defaults to 90 days', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const out = computeExpiresAt(undefined, now);
    expect(out.getTime() - now.getTime()).toBe(90 * 24 * 3600 * 1000);
  });

  it('honours custom retention', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const out = computeExpiresAt(7, now);
    expect(out.getTime() - now.getTime()).toBe(7 * 24 * 3600 * 1000);
  });
});
