import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';

import { BatchDatesController } from './controllers/batch-dates.controller';
import { BatchDatesRepository } from './repositories/batch-dates.repository';
import { BatchDatesService } from './services/batch-dates.service';

/**
 * BE-58 — Batch-aware crowd-sourced expiry (spec §B1/§B2).
 *
 * Intentionally tenant-less, like `barcode-learning` — see
 * `src/db/schema/batch-dates.ts` doc comment for why.
 */
@Module({
  imports: [AuthModule],
  controllers: [BatchDatesController],
  providers: [BatchDatesRepository, BatchDatesService],
  exports: [BatchDatesService],
})
export class BatchDatesModule {}
