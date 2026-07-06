import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
  Version,
} from '@nestjs/common';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser, Roles } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';

import {
  ImpersonationSessionAuditDto,
  StartImpersonationDto,
  StartImpersonationResponse,
  StartImpersonationSchema,
} from '../dto/start-impersonation.dto';
import { AdminImpersonationService } from '../services/admin-impersonation.service';

/**
 * BE-53 — Admin Impersonation REST controller.
 *
 * Endpoints (all under `/api/v1/admin`):
 *   POST   /admin/impersonate            — start a session
 *   DELETE /admin/impersonate            — end the staff member's
 *                                          current session
 *   GET    /admin/impersonations/audit   — list past sessions
 *
 * Every route here is admin-gated: `@Roles('admin')` forces the
 * request to come from a RADHA support staff member. The service
 * layer re-checks the role to defend against decorator drift.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminImpersonationController {
  constructor(private readonly service: AdminImpersonationService) {}

  @Post('admin/impersonate')
  @Version('1')
  @HttpCode(201)
  start(
    @Body(new ZodValidationPipe(StartImpersonationSchema)) dto: StartImpersonationDto,
    @CurrentUser('id') staffUserId: string,
    @CurrentUser('role') staffRole: string,
    @Req() req: { ip?: string; headers: Record<string, string | string[] | undefined> },
  ): Promise<StartImpersonationResponse> {
    return this.service.start(staffUserId, staffRole, dto, {
      ipAddress: req.ip,
      userAgent: pickHeader(req.headers['user-agent']),
    });
  }

  @Delete('admin/impersonate')
  @Version('1')
  @HttpCode(200)
  async end(
    @CurrentUser('id') staffUserId: string,
    @Req() req: { ip?: string; headers: Record<string, string | string[] | undefined> },
  ): Promise<{ sessionId: string; endedAt: string }> {
    const result = await this.service.endCurrent(staffUserId, {
      ipAddress: req.ip,
      userAgent: pickHeader(req.headers['user-agent']),
    });
    if (!result) {
      throw new BusinessException(
        ErrorCode.NOT_FOUND,
        'No active impersonation session for the current admin',
      );
    }
    return result;
  }

  @Get('admin/impersonations/audit')
  @Version('1')
  listAudit(
    @Query('staffUserId') staffUserId?: string,
    @Query('impersonatedUserId') impersonatedUserId?: string,
    @Query('limit') limitRaw?: string,
  ): Promise<ImpersonationSessionAuditDto[]> {
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    return this.service.listAudit({
      staffUserId,
      impersonatedUserId,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
  }
}

function pickHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}
