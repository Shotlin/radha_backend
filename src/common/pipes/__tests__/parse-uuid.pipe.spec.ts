import { BadRequestException } from '@nestjs/common';

import { ParseUuidPipe } from '../parse-uuid.pipe';

describe('ParseUuidPipe', () => {
  const pipe = new ParseUuidPipe();
  const meta = { type: 'param' as const, data: 'id' };

  it('accepts a valid v4 UUID', () => {
    expect(pipe.transform('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', meta)).toBe(
      'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    );
  });

  it('rejects non-string values', () => {
    expect(() => pipe.transform(42, meta)).toThrow(BadRequestException);
  });

  it('rejects malformed UUIDs', () => {
    expect(() => pipe.transform('not-a-uuid', meta)).toThrow(BadRequestException);
  });
});
