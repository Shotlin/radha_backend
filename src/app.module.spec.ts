import { Test, TestingModule } from '@nestjs/testing';

import { DbService } from '@/db/db.service';

import { AppModule } from './app.module';

/**
 * Smoke test: AppModule must wire its provider graph without missing
 * dependencies. We don't actually need a live Postgres connection for
 * this — `DbService.getDb()` is invoked synchronously in many
 * repository constructors, so we replace `DbService` with a stub that
 * returns a no-op drizzle handle. The point of the test is module
 * composition, not connectivity.
 */
describe('AppModule', () => {
  it('compiles successfully', async () => {
    const fakeDb: Record<string, unknown> = {};
    const noop = (): unknown => fakeDb;
    Object.assign(fakeDb, {
      transaction: async () => undefined,
      execute: async () => [],
      select: noop,
      from: noop,
      insert: noop,
      update: noop,
      delete: noop,
      where: noop,
      returning: () => Promise.resolve([]),
      values: noop,
      set: noop,
      onConflictDoNothing: noop,
      onConflictDoUpdate: noop,
      orderBy: noop,
      limit: noop,
      offset: noop,
      leftJoin: noop,
      innerJoin: noop,
      groupBy: noop,
    });

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DbService)
      .useValue({
        getDb: () => fakeDb,
        ping: async () => true,
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(fakeDb),
        close: async () => undefined,
        onModuleInit: async () => undefined,
        onModuleDestroy: async () => undefined,
      })
      .compile();

    expect(module).toBeDefined();
    await module.close();
  });
});
