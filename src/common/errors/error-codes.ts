/**
 * Centralised error-code catalog for the RADHA backend.
 *
 * Codes are stable strings of the form `EXNNN` so that:
 *   - the Mobile_App can switch on them across versions,
 *   - log-aggregators can group by code,
 *   - Sentry breadcrumbs include them as a tag,
 *   - documentation can index them.
 *
 * Numbering ranges:
 *   1xxx  Generic / infrastructure
 *   2xxx  Validation
 *   3xxx  Authentication
 *   4xxx  Authorization / entitlements
 *   5xxx  Resources (not found)
 *   6xxx  Conflicts
 *   7xxx  Business rules
 *   8xxx  External service failures
 *   9xxx  Database failures
 */

export enum ErrorCode {
  // ── Generic (1xxx) ────────────────────────────────────────────────
  UNKNOWN_ERROR = 'E1000',
  INTERNAL_SERVER_ERROR = 'E1001',
  SERVICE_UNAVAILABLE = 'E1002',
  TIMEOUT = 'E1003',
  RATE_LIMIT_EXCEEDED = 'E1004',
  REQUEST_TOO_LARGE = 'E1005',

  // ── Validation (2xxx) ─────────────────────────────────────────────
  VALIDATION_ERROR = 'E2000',
  INVALID_INPUT = 'E2001',
  MISSING_REQUIRED_FIELD = 'E2002',
  INVALID_FORMAT = 'E2003',
  VALUE_OUT_OF_RANGE = 'E2004',

  // ── Authentication (3xxx) ─────────────────────────────────────────
  AUTHENTICATION_REQUIRED = 'E3000',
  INVALID_CREDENTIALS = 'E3001',
  TOKEN_EXPIRED = 'E3002',
  TOKEN_INVALID = 'E3003',
  TOKEN_REVOKED = 'E3004',
  OTP_INVALID = 'E3005',
  OTP_EXPIRED = 'E3006',
  OTP_TOO_MANY_ATTEMPTS = 'E3007',
  ACCOUNT_LOCKED = 'E3008',

  // ── Authorization (4xxx) ──────────────────────────────────────────
  FORBIDDEN = 'E4000',
  INSUFFICIENT_PERMISSIONS = 'E4001',
  TENANT_ACCESS_DENIED = 'E4002',
  STORE_ACCESS_DENIED = 'E4003',
  ROLE_REQUIRED = 'E4004',
  SUBSCRIPTION_REQUIRED = 'E4005',
  TRIAL_EXPIRED = 'E4006',
  PLAN_LIMIT_EXCEEDED = 'E4007',
  PAYMENT_REQUIRED = 'E4008',

  // ── Resources / Not Found (5xxx) ──────────────────────────────────
  NOT_FOUND = 'E5000',
  USER_NOT_FOUND = 'E5001',
  PRODUCT_NOT_FOUND = 'E5002',
  STORE_NOT_FOUND = 'E5003',
  TENANT_NOT_FOUND = 'E5004',
  TASK_NOT_FOUND = 'E5005',
  REPORT_NOT_FOUND = 'E5006',
  SCAN_SESSION_NOT_FOUND = 'E5007',
  EAN_LIST_NOT_FOUND = 'E5008',
  RESOURCE_GONE = 'E5009',

  // ── Conflicts (6xxx) ──────────────────────────────────────────────
  CONFLICT = 'E6000',
  DUPLICATE_RESOURCE = 'E6001',
  EAN_ALREADY_EXISTS = 'E6002',
  USER_ALREADY_EXISTS = 'E6003',
  STALE_DATA = 'E6004',
  CONCURRENT_MODIFICATION = 'E6005',
  IDEMPOTENCY_KEY_REUSE = 'E6006',

  // ── Business rules (7xxx) ─────────────────────────────────────────
  BUSINESS_RULE_VIOLATION = 'E7000',
  SCAN_SESSION_CLOSED = 'E7001',
  TASK_ALREADY_COMPLETED = 'E7002',
  GRN_ALREADY_POSTED = 'E7003',
  INSUFFICIENT_STOCK = 'E7004',
  EXPIRY_DATE_PAST = 'E7005',
  INVALID_EAN_FORMAT = 'E7006',
  PRODUCT_DISCONTINUED = 'E7007',
  FAMILY_SHARING_LIMIT_REACHED = 'E7008',

  // ── External services (8xxx) ──────────────────────────────────────
  EXTERNAL_SERVICE_ERROR = 'E8000',
  SMS_DELIVERY_FAILED = 'E8001',
  S3_UPLOAD_FAILED = 'E8002',
  S3_DOWNLOAD_FAILED = 'E8003',
  OPEN_FOOD_FACTS_UNAVAILABLE = 'E8004',
  AI_SERVICE_ERROR = 'E8005',
  EMAIL_DELIVERY_FAILED = 'E8006',
  PAYMENT_PROVIDER_ERROR = 'E8007',

  // ── Database (9xxx) ───────────────────────────────────────────────
  DATABASE_ERROR = 'E9000',
  DATABASE_CONNECTION_FAILED = 'E9001',
  DATABASE_QUERY_FAILED = 'E9002',
  DATABASE_TIMEOUT = 'E9003',
  DATABASE_DEADLOCK = 'E9004',
}

/**
 * Map every `ErrorCode` to the HTTP status it surfaces with.
 *
 * `Record<ErrorCode, number>` here gives us a *compile-time* exhaustiveness
 * check: forgetting to map a new code makes the build fail.
 */
export const ERROR_CODE_TO_HTTP_STATUS: Record<ErrorCode, number> = {
  // Generic
  [ErrorCode.UNKNOWN_ERROR]: 500,
  [ErrorCode.INTERNAL_SERVER_ERROR]: 500,
  [ErrorCode.SERVICE_UNAVAILABLE]: 503,
  [ErrorCode.TIMEOUT]: 504,
  [ErrorCode.RATE_LIMIT_EXCEEDED]: 429,
  [ErrorCode.REQUEST_TOO_LARGE]: 413,

  // Validation
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.INVALID_INPUT]: 400,
  [ErrorCode.MISSING_REQUIRED_FIELD]: 400,
  [ErrorCode.INVALID_FORMAT]: 400,
  [ErrorCode.VALUE_OUT_OF_RANGE]: 400,

  // Authentication
  [ErrorCode.AUTHENTICATION_REQUIRED]: 401,
  [ErrorCode.INVALID_CREDENTIALS]: 401,
  [ErrorCode.TOKEN_EXPIRED]: 401,
  [ErrorCode.TOKEN_INVALID]: 401,
  [ErrorCode.TOKEN_REVOKED]: 401,
  [ErrorCode.OTP_INVALID]: 401,
  [ErrorCode.OTP_EXPIRED]: 401,
  [ErrorCode.OTP_TOO_MANY_ATTEMPTS]: 429,
  [ErrorCode.ACCOUNT_LOCKED]: 403,

  // Authorization
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.INSUFFICIENT_PERMISSIONS]: 403,
  [ErrorCode.TENANT_ACCESS_DENIED]: 403,
  [ErrorCode.STORE_ACCESS_DENIED]: 403,
  [ErrorCode.ROLE_REQUIRED]: 403,
  [ErrorCode.SUBSCRIPTION_REQUIRED]: 402,
  [ErrorCode.TRIAL_EXPIRED]: 402,
  [ErrorCode.PLAN_LIMIT_EXCEEDED]: 402,
  [ErrorCode.PAYMENT_REQUIRED]: 402,

  // Not found
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.USER_NOT_FOUND]: 404,
  [ErrorCode.PRODUCT_NOT_FOUND]: 404,
  [ErrorCode.STORE_NOT_FOUND]: 404,
  [ErrorCode.TENANT_NOT_FOUND]: 404,
  [ErrorCode.TASK_NOT_FOUND]: 404,
  [ErrorCode.REPORT_NOT_FOUND]: 404,
  [ErrorCode.SCAN_SESSION_NOT_FOUND]: 404,
  [ErrorCode.EAN_LIST_NOT_FOUND]: 404,
  [ErrorCode.RESOURCE_GONE]: 410,

  // Conflicts
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.DUPLICATE_RESOURCE]: 409,
  [ErrorCode.EAN_ALREADY_EXISTS]: 409,
  [ErrorCode.USER_ALREADY_EXISTS]: 409,
  [ErrorCode.STALE_DATA]: 409,
  [ErrorCode.CONCURRENT_MODIFICATION]: 409,
  [ErrorCode.IDEMPOTENCY_KEY_REUSE]: 409,

  // Business rules — 422 by default for "your request was understood,
  // but the current state forbids it"
  [ErrorCode.BUSINESS_RULE_VIOLATION]: 422,
  [ErrorCode.SCAN_SESSION_CLOSED]: 422,
  [ErrorCode.TASK_ALREADY_COMPLETED]: 422,
  [ErrorCode.GRN_ALREADY_POSTED]: 422,
  [ErrorCode.INSUFFICIENT_STOCK]: 422,
  [ErrorCode.EXPIRY_DATE_PAST]: 422,
  [ErrorCode.INVALID_EAN_FORMAT]: 422,
  [ErrorCode.PRODUCT_DISCONTINUED]: 422,
  [ErrorCode.FAMILY_SHARING_LIMIT_REACHED]: 409,

  // External
  [ErrorCode.EXTERNAL_SERVICE_ERROR]: 502,
  [ErrorCode.SMS_DELIVERY_FAILED]: 502,
  [ErrorCode.S3_UPLOAD_FAILED]: 502,
  [ErrorCode.S3_DOWNLOAD_FAILED]: 502,
  [ErrorCode.OPEN_FOOD_FACTS_UNAVAILABLE]: 502,
  [ErrorCode.AI_SERVICE_ERROR]: 502,
  [ErrorCode.EMAIL_DELIVERY_FAILED]: 502,
  [ErrorCode.PAYMENT_PROVIDER_ERROR]: 502,

  // Database
  [ErrorCode.DATABASE_ERROR]: 500,
  [ErrorCode.DATABASE_CONNECTION_FAILED]: 503,
  [ErrorCode.DATABASE_QUERY_FAILED]: 500,
  [ErrorCode.DATABASE_TIMEOUT]: 504,
  [ErrorCode.DATABASE_DEADLOCK]: 503,
};

/** Default user-facing message per code. Mobile_App can override per locale. */
export const ERROR_CODE_DEFAULT_MESSAGE: Record<ErrorCode, string> = {
  [ErrorCode.UNKNOWN_ERROR]: 'Something went wrong. Please try again.',
  [ErrorCode.INTERNAL_SERVER_ERROR]: 'Internal server error.',
  [ErrorCode.SERVICE_UNAVAILABLE]: 'Service is temporarily unavailable.',
  [ErrorCode.TIMEOUT]: 'Request timed out.',
  [ErrorCode.RATE_LIMIT_EXCEEDED]: 'Too many requests. Please slow down.',
  [ErrorCode.REQUEST_TOO_LARGE]: 'Request body is too large.',

  [ErrorCode.VALIDATION_ERROR]: 'Validation failed.',
  [ErrorCode.INVALID_INPUT]: 'Invalid input.',
  [ErrorCode.MISSING_REQUIRED_FIELD]: 'A required field is missing.',
  [ErrorCode.INVALID_FORMAT]: 'Value is not in the expected format.',
  [ErrorCode.VALUE_OUT_OF_RANGE]: 'Value is out of the allowed range.',

  [ErrorCode.AUTHENTICATION_REQUIRED]: 'Please sign in to continue.',
  [ErrorCode.INVALID_CREDENTIALS]: 'Invalid credentials.',
  [ErrorCode.TOKEN_EXPIRED]: 'Session expired. Please sign in again.',
  [ErrorCode.TOKEN_INVALID]: 'Invalid session.',
  [ErrorCode.TOKEN_REVOKED]: 'Session has been revoked.',
  [ErrorCode.OTP_INVALID]: 'OTP is incorrect.',
  [ErrorCode.OTP_EXPIRED]: 'OTP has expired.',
  [ErrorCode.OTP_TOO_MANY_ATTEMPTS]: 'Too many attempts. Try later.',
  [ErrorCode.ACCOUNT_LOCKED]: 'Account is locked.',

  [ErrorCode.FORBIDDEN]: 'You do not have permission to perform this action.',
  [ErrorCode.INSUFFICIENT_PERMISSIONS]: 'Insufficient permissions.',
  [ErrorCode.TENANT_ACCESS_DENIED]: 'Access to this tenant is denied.',
  [ErrorCode.STORE_ACCESS_DENIED]: 'Access to this store is denied.',
  [ErrorCode.ROLE_REQUIRED]: 'Your role does not allow this action.',
  [ErrorCode.SUBSCRIPTION_REQUIRED]: 'A paid subscription is required.',
  [ErrorCode.TRIAL_EXPIRED]: 'Your trial has expired.',
  [ErrorCode.PLAN_LIMIT_EXCEEDED]: 'You have exceeded your plan limit.',
  [ErrorCode.PAYMENT_REQUIRED]: 'Payment required to access this feature.',

  [ErrorCode.NOT_FOUND]: 'Resource not found.',
  [ErrorCode.USER_NOT_FOUND]: 'User not found.',
  [ErrorCode.PRODUCT_NOT_FOUND]: 'Product not found.',
  [ErrorCode.STORE_NOT_FOUND]: 'Store not found.',
  [ErrorCode.TENANT_NOT_FOUND]: 'Tenant not found.',
  [ErrorCode.TASK_NOT_FOUND]: 'Task not found.',
  [ErrorCode.REPORT_NOT_FOUND]: 'Report not found.',
  [ErrorCode.SCAN_SESSION_NOT_FOUND]: 'Scan session not found.',
  [ErrorCode.EAN_LIST_NOT_FOUND]: 'EAN list not found.',
  [ErrorCode.RESOURCE_GONE]: 'This resource is no longer available.',

  [ErrorCode.CONFLICT]: 'Operation conflicts with current state.',
  [ErrorCode.DUPLICATE_RESOURCE]: 'A resource with these properties already exists.',
  [ErrorCode.EAN_ALREADY_EXISTS]: 'This EAN is already registered.',
  [ErrorCode.USER_ALREADY_EXISTS]: 'A user with this identifier already exists.',
  [ErrorCode.STALE_DATA]: 'Data is stale. Reload and try again.',
  [ErrorCode.CONCURRENT_MODIFICATION]: 'Resource was modified concurrently.',
  [ErrorCode.IDEMPOTENCY_KEY_REUSE]: 'Idempotency-Key reused with a different payload.',

  [ErrorCode.BUSINESS_RULE_VIOLATION]: 'This action violates a business rule.',
  [ErrorCode.SCAN_SESSION_CLOSED]: 'Scan session is closed.',
  [ErrorCode.TASK_ALREADY_COMPLETED]: 'Task is already completed.',
  [ErrorCode.GRN_ALREADY_POSTED]: 'GRN has already been posted.',
  [ErrorCode.INSUFFICIENT_STOCK]: 'Insufficient stock for this operation.',
  [ErrorCode.EXPIRY_DATE_PAST]: 'Expiry date is in the past.',
  [ErrorCode.INVALID_EAN_FORMAT]: 'Invalid EAN format.',
  [ErrorCode.PRODUCT_DISCONTINUED]: 'Product has been discontinued.',
  [ErrorCode.FAMILY_SHARING_LIMIT_REACHED]: 'Family sharing limit reached.',

  [ErrorCode.EXTERNAL_SERVICE_ERROR]: 'External service error.',
  [ErrorCode.SMS_DELIVERY_FAILED]: 'SMS delivery failed.',
  [ErrorCode.S3_UPLOAD_FAILED]: 'File upload failed.',
  [ErrorCode.S3_DOWNLOAD_FAILED]: 'File download failed.',
  [ErrorCode.OPEN_FOOD_FACTS_UNAVAILABLE]: 'Product database is unavailable.',
  [ErrorCode.AI_SERVICE_ERROR]: 'AI service error.',
  [ErrorCode.EMAIL_DELIVERY_FAILED]: 'Email delivery failed.',
  [ErrorCode.PAYMENT_PROVIDER_ERROR]: 'Payment provider error.',

  [ErrorCode.DATABASE_ERROR]: 'Database error.',
  [ErrorCode.DATABASE_CONNECTION_FAILED]: 'Database connection failed.',
  [ErrorCode.DATABASE_QUERY_FAILED]: 'Database query failed.',
  [ErrorCode.DATABASE_TIMEOUT]: 'Database timed out.',
  [ErrorCode.DATABASE_DEADLOCK]: 'Database deadlock detected.',
};
