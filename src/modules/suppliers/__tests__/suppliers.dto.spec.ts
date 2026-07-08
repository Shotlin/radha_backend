import { CreateSupplierSchema, GST_REGEX, PAN_REGEX } from '../dto/create-supplier.dto';
import { ListSuppliersSchema } from '../dto/list-suppliers.dto';
import { BlacklistSupplierSchema, UpdateSupplierSchema } from '../dto/update-supplier.dto';

/**
 * BE-25 — DTO validation tests.
 *
 * Pure schema-level checks. No NestJS bootstrap, no DB. Each test
 * exercises one rule so a failure points right at the offending
 * predicate.
 */

describe('CreateSupplierSchema', () => {
  const valid = {
    name: 'Acme Distributors',
    country: 'IN',
  };

  it('accepts a minimal valid supplier', () => {
    const result = CreateSupplierSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects an empty name', () => {
    const result = CreateSupplierSchema.safeParse({ ...valid, name: '' });
    expect(result.success).toBe(false);
  });

  it.each([
    ['27AAPFU0939F1ZV', true],
    ['29ABCDE1234F1Z5', true],
    ['INVALID-GST', false],
    ['27aapfu0939f1zv', true], // lowercased input ⇒ schema upper-cases first
  ])('GST %s → valid=%s (post-uppercase)', (gst, expected) => {
    const result = CreateSupplierSchema.safeParse({ ...valid, gstNumber: gst });
    expect(result.success).toBe(expected);
  });

  it.each([
    ['ABCDE1234F', true],
    ['ABCDE12345', false],
    ['1ABCD1234F', false],
    ['abcde1234f', true], // schema upper-cases first
  ])('PAN %s → valid=%s (post-uppercase)', (pan, expected) => {
    const result = CreateSupplierSchema.safeParse({ ...valid, panNumber: pan });
    expect(result.success).toBe(expected);
  });

  it('rejects invalid pincode', () => {
    const result = CreateSupplierSchema.safeParse({ ...valid, pincode: '12' });
    expect(result.success).toBe(false);
  });

  it('rejects an Indian mobile starting with 5', () => {
    const result = CreateSupplierSchema.safeParse({
      ...valid,
      whatsappNumber: '5234567890',
    });
    expect(result.success).toBe(false);
  });

  it('accepts an Indian mobile starting with 9', () => {
    const result = CreateSupplierSchema.safeParse({
      ...valid,
      whatsappNumber: '9234567890',
    });
    expect(result.success).toBe(true);
  });

  it('caps the contacts list at 20', () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      name: `c-${i}`,
    }));
    const result = CreateSupplierSchema.safeParse({ ...valid, contacts: tooMany });
    expect(result.success).toBe(false);
  });

  it('rejects a lowercase code (regex requires uppercase)', () => {
    const result = CreateSupplierSchema.safeParse({ ...valid, code: 'sup-acme-1' });
    expect(result.success).toBe(false);
  });

  it('exports a regex matching valid GSTs', () => {
    expect(GST_REGEX.test('27AAPFU0939F1ZV')).toBe(true);
    expect(GST_REGEX.test('not-a-gst')).toBe(false);
  });

  it('exports a regex matching valid PANs', () => {
    expect(PAN_REGEX.test('ABCDE1234F')).toBe(true);
    expect(PAN_REGEX.test('not-a-pan')).toBe(false);
  });
});

describe('UpdateSupplierSchema', () => {
  it('rejects an empty payload', () => {
    const result = UpdateSupplierSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts a single-field update', () => {
    const result = UpdateSupplierSchema.safeParse({ name: 'Renamed' });
    expect(result.success).toBe(true);
  });

  it('accepts explicit nulls (clearing a field)', () => {
    const result = UpdateSupplierSchema.safeParse({ category: null });
    expect(result.success).toBe(true);
  });

  it('rejects malformed GST in update', () => {
    const result = UpdateSupplierSchema.safeParse({ gstNumber: 'BAD' });
    expect(result.success).toBe(false);
  });
});

describe('BlacklistSupplierSchema', () => {
  it('requires a non-empty reason', () => {
    expect(BlacklistSupplierSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(BlacklistSupplierSchema.safeParse({ reason: 'fraud' }).success).toBe(true);
  });
});

describe('ListSuppliersSchema', () => {
  it('parses a comma-separated status list', () => {
    const result = ListSuppliersSchema.parse({ status: 'active,blacklisted' });
    expect(result.status).toEqual(['active', 'blacklisted']);
  });

  it('drops unknown status tokens silently', () => {
    const result = ListSuppliersSchema.parse({ status: 'active,bogus' });
    expect(result.status).toEqual(['active']);
  });

  it('caps limit at 200', () => {
    expect(() => ListSuppliersSchema.parse({ limit: '500' })).toThrow();
  });

  it('defaults limit to 50', () => {
    const result = ListSuppliersSchema.parse({});
    expect(result.limit).toBe(50);
  });
});
