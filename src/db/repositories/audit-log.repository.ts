import type { DrizzleDb } from '../connection';
import { auditLogs, type AuditLogRow, type NewAuditLog } from '../schema/audit-logs';

import { BaseRepository } from './base.repository';

/**
 * BE-05's first concrete repository.
 *
 * Backs `AuditLogService` (BE-04) so the audit trail finally lands in
 * Postgres. Every CRUD method comes for free from `BaseRepository`;
 * this class just nails down the table reference and the entity types.
 */
export class AuditLogRepository extends BaseRepository<
  typeof auditLogs,
  AuditLogRow,
  NewAuditLog,
  Partial<NewAuditLog>
> {
  constructor(db: DrizzleDb) {
    super(db, auditLogs, 'audit_logs');
  }
}
