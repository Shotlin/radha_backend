import { ERROR_CODE_DEFAULT_MESSAGE, ERROR_CODE_TO_HTTP_STATUS, ErrorCode } from '../error-codes';

describe('ErrorCode catalog', () => {
  const allCodes = Object.values(ErrorCode);

  it('every ErrorCode has a unique code string', () => {
    expect(new Set(allCodes).size).toBe(allCodes.length);
  });

  it('every ErrorCode is mapped to an HTTP status', () => {
    for (const code of allCodes) {
      const status = ERROR_CODE_TO_HTTP_STATUS[code];
      expect(typeof status).toBe('number');
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  it('every ErrorCode has a default user-facing message', () => {
    for (const code of allCodes) {
      const msg = ERROR_CODE_DEFAULT_MESSAGE[code];
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it('numbering ranges align with category', () => {
    const expectations: Array<[ErrorCode, number]> = [
      [ErrorCode.UNKNOWN_ERROR, 500],
      [ErrorCode.VALIDATION_ERROR, 400],
      [ErrorCode.AUTHENTICATION_REQUIRED, 401],
      [ErrorCode.FORBIDDEN, 403],
      [ErrorCode.NOT_FOUND, 404],
      [ErrorCode.CONFLICT, 409],
      [ErrorCode.BUSINESS_RULE_VIOLATION, 422],
      [ErrorCode.EXTERNAL_SERVICE_ERROR, 502],
      [ErrorCode.DATABASE_ERROR, 500],
    ];
    for (const [code, status] of expectations) {
      expect(ERROR_CODE_TO_HTTP_STATUS[code]).toBe(status);
    }
  });

  it('catalog is at least 60 codes deep', () => {
    expect(allCodes.length).toBeGreaterThanOrEqual(60);
  });
});
