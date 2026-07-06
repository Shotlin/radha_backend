export type AuditAction =
  | 'CREATE'
  | 'READ'
  | 'UPDATE'
  | 'DELETE'
  | 'LOGIN'
  | 'LOGOUT'
  | 'EXPORT'
  | 'IMPORT'
  | 'GRANT_ACCESS'
  | 'REVOKE_ACCESS';

export interface AuditEntry {
  action: AuditAction;
  resourceType: string;
  resourceId: string;
  userId: string;
  tenantId: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  timestamp?: Date;
  success: boolean;
  errorCode?: string;
}

export interface AuditQueryFilters {
  userId?: string;
  tenantId?: string;
  action?: AuditAction;
  resourceType?: string;
  resourceId?: string;
  startDate?: Date;
  endDate?: Date;
  success?: boolean;
  limit?: number;
  cursor?: string;
}

export interface IAuditLogService {
  logAction(entry: AuditEntry): Promise<void>;
  logBatch(entries: AuditEntry[]): Promise<void>;
  query(filters: AuditQueryFilters): Promise<AuditEntry[]>;
}

export const AUDIT_LOG_SERVICE = Symbol('AUDIT_LOG_SERVICE');
