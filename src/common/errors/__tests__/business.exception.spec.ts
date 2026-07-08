import {
  BusinessException,
  DomainConflictException,
  DomainForbiddenException,
  DomainNotFoundException,
  ExternalServiceException,
  ValidationException,
} from '../business.exception';
import { ErrorCode } from '../error-codes';

describe('BusinessException', () => {
  it('uses the canonical HTTP status for the code', () => {
    const ex = new BusinessException(ErrorCode.VALIDATION_ERROR, 'bad');
    expect(ex.getStatus()).toBe(400);
    expect(ex.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('falls back to the default message when none is provided', () => {
    const ex = new BusinessException(ErrorCode.PRODUCT_NOT_FOUND);
    const body = ex.getResponse() as Record<string, unknown>;
    expect(body.message).toBe('Product not found.');
    expect(body.code).toBe(ErrorCode.PRODUCT_NOT_FOUND);
  });

  it('omits the details key when absent', () => {
    const ex = new BusinessException(ErrorCode.UNKNOWN_ERROR);
    const body = ex.getResponse() as Record<string, unknown>;
    expect('details' in body).toBe(false);
  });

  it('includes details when provided', () => {
    const ex = new BusinessException(ErrorCode.VALIDATION_ERROR, 'bad', {
      field: 'email',
      value: 'oops',
    });
    const body = ex.getResponse() as Record<string, unknown>;
    expect(body.details).toEqual({ field: 'email', value: 'oops' });
  });
});

describe('Specialised exceptions', () => {
  it('ValidationException → 400 with VALIDATION_ERROR', () => {
    const ex = new ValidationException('boom', { field: 'x' });
    expect(ex.getStatus()).toBe(400);
    expect(ex.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('DomainNotFoundException → 404 with formatted message', () => {
    const ex = new DomainNotFoundException('User', 'u-1');
    expect(ex.getStatus()).toBe(404);
    expect(ex.message).toBe('User not found (id: u-1)');
  });

  it('DomainNotFoundException without id', () => {
    const ex = new DomainNotFoundException('Tenant');
    expect(ex.message).toBe('Tenant not found');
  });

  it('DomainForbiddenException accepts a custom auth code', () => {
    const ex = new DomainForbiddenException('nope', ErrorCode.TENANT_ACCESS_DENIED);
    expect(ex.code).toBe(ErrorCode.TENANT_ACCESS_DENIED);
    expect(ex.getStatus()).toBe(403);
  });

  it('DomainConflictException → 409', () => {
    const ex = new DomainConflictException('dup', ErrorCode.DUPLICATE_RESOURCE);
    expect(ex.getStatus()).toBe(409);
    expect(ex.code).toBe(ErrorCode.DUPLICATE_RESOURCE);
  });

  it('ExternalServiceException carries the original cause', () => {
    const cause = new Error('timeout reading off');
    const ex = new ExternalServiceException(
      'open-food-facts',
      cause,
      ErrorCode.OPEN_FOOD_FACTS_UNAVAILABLE,
    );
    expect(ex.getStatus()).toBe(502);
    expect(ex.code).toBe(ErrorCode.OPEN_FOOD_FACTS_UNAVAILABLE);
    const body = ex.getResponse() as Record<string, unknown>;
    expect((body.details as Record<string, unknown>).metadata).toMatchObject({
      service: 'open-food-facts',
      originalMessage: 'timeout reading off',
    });
  });
});
