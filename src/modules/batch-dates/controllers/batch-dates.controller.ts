import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
  Version,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser, Roles } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';

import { CreateObservationDto, CreateObservationSchema } from '../dto/batch-dates.dto';
import { BatchDatesResponse, BatchDatesService, BatchSummary } from '../services/batch-dates.service';

/**
 * BE-58 — Batch-aware crowd-sourced expiry REST surface (spec §B2).
 *
 * Consumer-facing, JWT auth only (like `barcode-learning`'s consumer
 * controller) -- no tenant scoping, since a batch's real-world expiry
 * date is a fact about the physical product, shared across every tenant.
 */
@Controller('products/:ean/batches')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('consumer', 'staff', 'manager', 'owner', 'admin')
export class BatchDatesController {
  constructor(private readonly svc: BatchDatesService) {}

  @Get()
  @Version('1')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  list(@Param('ean') ean: string): Promise<{ batches: BatchSummary[] }> {
    return this.svc.listBatchesForProduct(ean).then((batches) => ({ batches }));
  }

  @Get(':batchCode/dates')
  @Version('1')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  getDates(
    @Param('ean') ean: string,
    @Param('batchCode') batchCode: string,
  ): Promise<BatchDatesResponse> {
    return this.svc.getBatchDates(ean, batchCode);
  }

  @Post(':batchCode/observations')
  @Version('1')
  @HttpCode(201)
  // Burst throttle on top of the 20/day DB-counted quota
  // (BatchDatesService.MAX_OBSERVATIONS_PER_DAY) -- that limit is
  // untouched; this only stops rapid-fire abuse within a single day's
  // allowance (mirrors barcode-learning's identical pattern).
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  submit(
    @CurrentUser('id') userId: string,
    @Param('ean') ean: string,
    @Param('batchCode') batchCode: string,
    @Body(new ZodValidationPipe(CreateObservationSchema)) dto: CreateObservationDto,
  ): Promise<{ consensus: BatchDatesResponse }> {
    return this.svc
      .submitObservation(userId, ean, batchCode, dto)
      .then((consensus) => ({ consensus }));
  }
}
