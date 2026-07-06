import type { DrizzleDb, Transaction } from './connection';

export type IsolationLevel =
  | 'read uncommitted'
  | 'read committed'
  | 'repeatable read'
  | 'serializable';

export interface TransactionOptions {
  isolationLevel?: IsolationLevel;
  readOnly?: boolean;
  deferrable?: boolean;
  timeoutMs?: number;
}

export interface IDbService {
  getDb(): DrizzleDb;
  ping(): Promise<boolean>;
  transaction<T>(
    callback: (tx: Transaction) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
  close(timeoutSeconds?: number): Promise<void>;
}
