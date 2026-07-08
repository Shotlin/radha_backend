import { decodeCursor, encodeCursor } from '../pagination.utils';

describe('cursor pagination utils', () => {
  it('round-trips a multi-field cursor', () => {
    const orderBy = [
      { field: 'createdAt', direction: 'desc' as const },
      { field: 'id', direction: 'desc' as const },
    ];
    const record = { createdAt: '2026-05-17T00:00:00.000Z', id: 'r-1', extra: 'ignored' };
    const cursor = encodeCursor(record, orderBy);
    expect(typeof cursor).toBe('string');
    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual({ createdAt: '2026-05-17T00:00:00.000Z', id: 'r-1' });
  });

  it('returns null for an unparseable cursor', () => {
    expect(decodeCursor('not-base64-data')).toBeNull();
  });

  it('encodes only the requested order fields', () => {
    const cursor = encodeCursor({ id: 'a', createdAt: 't', secret: 'leak' }, [
      { field: 'id', direction: 'asc' },
    ]);
    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual({ id: 'a' });
  });
});
