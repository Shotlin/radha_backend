import type { DbService } from '../db.service';
import type { Transaction } from '../connection';
import type { TransactionOptions } from '../db.types';

/**
 * Helper that runs `callback` inside a database transaction unless
 * an outer one is already in flight.
 *
 *   - Composable: middleware/services can blindly call this; if a
 *     parent already opened a transaction it is re-used so we never
 *     accidentally nest savepoints.
 *   - Read-only and timeout overrides are honoured only when starting
 *     a new transaction.
 */
export const runInTransaction = async <T>(
  db: DbService,
  callback: (tx: Transaction) => Promise<T>,
  options?: TransactionOptions,
  existing?: Transaction,
): Promise<T> => {
  if (existing) return callback(existing);
  return db.transaction(callback, options);
};
