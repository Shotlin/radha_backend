import {
  Controller,
  ForbiddenException,
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
import { CurrentUser } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '@/modules/auth/types/permission.types';

import {
  AcknowledgeRecallAlertResponseDto,
  ListRecallAlertsQueryDto,
  ListRecallAlertsQuerySchema,
  RecallAlertListResponseDto,
} from '../dto/recall.dto';
import { RecallService } from '../services/recall.service';

/**
 * BE-39 — Consumer Recall Alerts API.
 *
 *   GET  /api/v1/recall/alerts                 — list current user's alerts
 *   POST /api/v1/recall/alerts/:id/acknowledge — mark an alert acknowledged
 *
 * Authenticated, tenant-scoped via the user's `tenantId`. Users
 * without a personal tenant (brand-new signups before BE-09 v2
 * personal-tenant bootstrap) get a 403 — they can't have alerts
 * yet because saved-products won't have been linked to a tenant
 * either.
 */
@Controller('recall')
@UseGuards(JwtAuthGuard)
export class RecallController {
  constructor(private readonly svc: RecallService) {}

  @Get('alerts')
  @Version('1')
  async listAlerts(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(ListRecallAlertsQuerySchema)) query: ListRecallAlertsQueryDto,
  ): Promise<RecallAlertListResponseDto> {
    const tenantId = this.requireTenant(user);
    return this.svc.listAlerts(user.id, tenantId, {
      limit: query.limit,
      cursor: query.cursor,
      unacknowledgedOnly: query.unacknowledgedOnly,
    });
  }

  @Post('alerts/:id/acknowledge')
  @Version('1')
  @HttpCode(200)
  async acknowledge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUuidPipe()) id: string,
  ): Promise<AcknowledgeRecallAlertResponseDto> {
    const tenantId = this.requireTenant(user);
    return this.svc.acknowledge(user.id, tenantId, id);
  }

  private requireTenant(user: AuthenticatedUser): string {
    if (!user.tenantId) {
      throw new ForbiddenException('Recall alerts require a tenant scope');
    }
    return user.tenantId;
  }
}
