import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Database enums shared across phases.
 *
 * Adding new values is fine, removing/renaming them is a breaking
 * migration — do it via a `pgEnum` `ALTER TYPE` migration.
 */

export const auditActionEnum = pgEnum('audit_action', [
  'CREATE',
  'READ',
  'UPDATE',
  'DELETE',
  'LOGIN',
  'LOGOUT',
  'EXPORT',
  'IMPORT',
  'GRANT_ACCESS',
  'REVOKE_ACCESS',
]);
