import type { UserRole } from '@/shared-types';

/**
 * Request-scoped context propagated via AsyncLocalStorage / nestjs-cls.
 *
 * Populated by:
 *   - BE-03 RequestIdMiddleware  → requestId, startTime, userAgent, ipAddress
 *   - BE-08 AuthGuards           → userId, tenantId, role
 *   - BE-09 TenantScopeMiddleware (v2) → tenantId (final source of truth)
 *   - BE-44 IdempotencyMiddleware (v2) → idempotencyKey
 *
 * Read by every layer of the stack: logging, error filters, repositories,
 * audit trails, analytics emitters, and webhook senders.
 */
export interface IRequestContext {
  requestId: string;
  startTime: number;
  userAgent?: string;
  ipAddress?: string;
  userId?: string;
  tenantId?: string;
  storeId?: string;
  role?: UserRole;
  correlationId?: string;
  idempotencyKey?: string;
}

export interface IRequestContextService {
  set<K extends keyof IRequestContext>(key: K, value: IRequestContext[K]): void;
  get<K extends keyof IRequestContext>(key: K): IRequestContext[K] | undefined;
  getAll(): IRequestContext;
  getRequestId(): string;
  getUserId(): string | undefined;
  getTenantId(): string | undefined;
  getDuration(): number;
}
