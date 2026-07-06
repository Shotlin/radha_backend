import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
  Version,
} from '@nestjs/common';

import { ParseUuidPipe } from '@/common/pipes/parse-uuid.pipe';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser, Roles } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';

import {
  ApproveSubmissionDto,
  ApproveSubmissionSchema,
  QueueQueryDto,
  QueueQuerySchema,
  RejectSubmissionDto,
  RejectSubmissionSchema,
} from '../dto/moderate.dto';
import {
  ApproveResultDto,
  BarcodeLearningService,
  QueueResultDto,
  SubmissionDetailDto,
  SubmissionDto,
} from '../services/barcode-learning.service';

/**
 * BE-56 — Moderator-facing endpoints for the Barcode Learning queue.
 *
 *   GET  /api/v1/admin/learn/queue        — list pending / flagged entries
 *   GET  /api/v1/admin/learn/:id          — full detail + image URLs (BE-56 v2)
 *   POST /api/v1/admin/learn/:id/approve  — approve + upsert into catalog
 *   POST /api/v1/admin/learn/:id/reject   — reject with required reason
 *
 * Restricted to the `admin` role; all decisions are persisted by the
 * service layer with audit log entries.
 */
@Controller('admin/learn')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminSubmissionController {
  constructor(private readonly svc: BarcodeLearningService) {}

  @Get('queue')
  @Version('1')
  listQueue(
    @Query(new ZodValidationPipe(QueueQuerySchema)) query: QueueQueryDto,
  ): Promise<QueueResultDto> {
    return this.svc.listQueue({
      status: query.status,
      limit: query.limit,
      offset: query.offset,
    });
  }

  @Get(':id')
  @Version('1')
  getSubmission(@Param('id', new ParseUuidPipe()) id: string): Promise<SubmissionDetailDto> {
    return this.svc.getSubmission(id);
  }

  @Post(':id/approve')
  @Version('1')
  @HttpCode(200)
  approve(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentUser('id') moderatorId: string,
    @Body(new ZodValidationPipe(ApproveSubmissionSchema)) dto: ApproveSubmissionDto,
  ): Promise<ApproveResultDto> {
    return this.svc.approve(id, moderatorId, dto);
  }

  @Post(':id/reject')
  @Version('1')
  @HttpCode(200)
  reject(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentUser('id') moderatorId: string,
    @Body(new ZodValidationPipe(RejectSubmissionSchema)) dto: RejectSubmissionDto,
  ): Promise<SubmissionDto> {
    return this.svc.reject(id, moderatorId, dto);
  }
}
