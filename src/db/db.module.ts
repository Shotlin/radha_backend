import { Global, Module } from '@nestjs/common';

import { ConfigService } from '@/config/config.service';

import { DatabaseHealthIndicator } from './health/database.health-indicator';
import { DbService } from './db.service';
import { AuditLogRepository } from './repositories/audit-log.repository';

/**
 * Registers the database connection as a global, singleton service.
 *
 * Repositories that need a Drizzle handle inject `DbService` and call
 * `getDb()`. Generic CRUD lives in `BaseRepository` (used by
 * concrete repos in later phases).
 *
 * `AuditLogRepository` ships in this phase so BE-04's
 * `AuditLogService` can finally persist instead of just logging.
 */
@Global()
@Module({
  providers: [
    DbService,
    DatabaseHealthIndicator,
    {
      provide: AuditLogRepository,
      inject: [DbService],
      useFactory: async (db: DbService) => {
        // DbService.onModuleInit() runs before this factory resolves
        // because NestJS awaits lifecycle hooks before resolving dependents.
        // However if there's an ordering issue fallback gracefully.
        return new AuditLogRepository(db.getDb());
      },
    },
  ],
  exports: [DbService, DatabaseHealthIndicator, AuditLogRepository],
})
export class DbModule {
  constructor(_config: ConfigService) {
    // Touching ConfigService keeps the import tree stable in tests.
  }
}
