import { HttpException } from '@nestjs/common';

import { ERROR_CODE_DEFAULT_MESSAGE, ERROR_CODE_TO_HTTP_STATUS, ErrorCode } from './error-codes';

export interface ExceptionDetails {
  field?: string;
  value?: unknown;
  expected?: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Base class for every domain exception thrown in the RADHA backend.
 *
 * Carries:
 *   - a stable `ErrorCode` (so the Mobile_App can act on it),
 *   - an HTTP status derived from the code via the canonical map,
 *   - an optional `details` object used by `GlobalExceptionFilter` to
 *     populate the `error.details` field of the response envelope.
 *
 * Subclasses (`ValidationException`, `NotFoundException`, …) are
 * thin convenience wrappers — they exist purely to make controller
 * code readable and to give a stable identifier for `instanceof`
 * checks in tests.
 */
export class BusinessException extends HttpException {
  public readonly code: ErrorCode;
  public readonly details?: ExceptionDetails;

  constructor(code: ErrorCode, message?: string, details?: ExceptionDetails) {
    const status = ERROR_CODE_TO_HTTP_STATUS[code] ?? 500;
    const safeMessage = message ?? ERROR_CODE_DEFAULT_MESSAGE[code] ?? 'An error occurred';

    super(
      {
        code,
        message: safeMessage,
        ...(details !== undefined ? { details } : {}),
      },
      status,
    );

    this.code = code;
    this.details = details;
  }
}

export class ValidationException extends BusinessException {
  constructor(message?: string, details?: ExceptionDetails) {
    super(ErrorCode.VALIDATION_ERROR, message, details);
  }
}

export class DomainNotFoundException extends BusinessException {
  constructor(resource: string, id?: string) {
    super(ErrorCode.NOT_FOUND, `${resource} not found${id ? ` (id: ${id})` : ''}`, {
      metadata: { resource, ...(id !== undefined ? { id } : {}) },
    });
  }
}

export class DomainForbiddenException extends BusinessException {
  constructor(reason?: string, code: ErrorCode = ErrorCode.FORBIDDEN) {
    super(code, reason);
  }
}

export class DomainConflictException extends BusinessException {
  constructor(message?: string, code: ErrorCode = ErrorCode.CONFLICT, details?: ExceptionDetails) {
    super(code, message, details);
  }
}

export class ExternalServiceException extends BusinessException {
  constructor(
    service: string,
    originalError?: Error,
    code: ErrorCode = ErrorCode.EXTERNAL_SERVICE_ERROR,
  ) {
    super(code, `External service ${service} unavailable`, {
      metadata: {
        service,
        ...(originalError ? { originalMessage: originalError.message } : {}),
      },
    });
  }
}
