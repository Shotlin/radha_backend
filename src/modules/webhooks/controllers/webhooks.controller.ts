import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
  Version,
} from '@nestjs/common';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ParseUuidPipe } from '@/common/pipes/parse-uuid.pipe';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import {
  CurrentTenant,
  CurrentUser,
  RequireTenant,
  Roles,
} from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';
import { TenantScopeGuard } from '@/modules/auth/guards/tenant-scope.guard';
import { AuditLogService } from '@/observability/audit-log.service';

import {
  CreateEndpointDto,
  CreateEndpointSchema,
  WebhookEndpointDto,
} from '../dto/create-endpoint.dto';
import {
  ListDeliveriesQueryDto,
  ListDeliveriesQuerySchema,
  WebhookDeliveryDto,
  type DeliveryStatus,
} from '../dto/replay-delivery.dto';
import { WebhookDeliveriesRepository } from '../repositories/webhook-deliveries.repository';
import { WebhookDeliveryService } from '../services/webhook-delivery.service';
import { WebhookEndpointsService } from '../services/webhook-endpoints.service';

/**
 * BE-50 — Webhooks REST controller.
 *
 * Endpoints (under `/api/v1/webhooks`):
 *   POST   /webhooks/endpoints
 *   GET    /webhooks/endpoints
 *   DELETE /webhooks/endpoints/:id
 *   GET    /webhooks/deliveries?status=&limit=
 *   POST   /webhooks/deliveries/:id/replay
 *
 * Pro-tier check + 5-endpoint cap live in `WebhookEndpointsService`.
 * The controller is transport-only.
 */
@Controller('webhooks')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
@Roles('owner', 'manager', 'admin')
@RequireTenant()
export class WebhooksController {
  constructor(
    private readonly endpointsService: WebhookEndpointsService,
    private readonly deliveriesRepo: WebhookDeliveriesRepository,
    private readonly deliveryService: WebhookDeliveryService,
    private readonly audit: AuditLogService,
  ) {}

  // ── Endpoints ────────────────────────────────────────────────────

  @Post('endpoints')
  @Version('1')
  @HttpCode(201)
  createEndpoint(
    @Body(new ZodValidationPipe(CreateEndpointSchema)) input: CreateEndpointDto,
    @CurrentTenant() tenantId: string | null,
    @CurrentUser('id') userId: string,
  ): Promise<WebhookEndpointDto> {
    this.assertTenant(tenantId);
    return this.endpointsService.create(tenantId, userId, input);
  }

  @Get('endpoints')
  @Version('1')
  listEndpoints(
    @CurrentTenant() tenantId: string | null,
  ): Promise<WebhookEndpointDto[]> {
    this.assertTenant(tenantId);
    return this.endpointsService.list(tenantId);
  }

  @Delete('endpoints/:id')
  @Version('1')
  @HttpCode(204)
  async deleteEndpoint(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string | null,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    this.assertTenant(tenantId);
    await this.endpointsService.delete(tenantId, userId, id);
  }

  // ── Deliveries ───────────────────────────────────────────────────

  @Get('deliveries')
  @Version('1')
  async listDeliveries(
    @Query(new ZodValidationPipe(ListDeliveriesQuerySchema))
    query: ListDeliveriesQueryDto,
    @CurrentTenant() tenantId: string | null,
  ): Promise<WebhookDeliveryDto[]> {
    this.assertTenant(tenantId);
    await this.endpointsService.assertProTier(tenantId);
    const rows = await this.deliveriesRepo.listForTenant(tenantId, {
      status: query.status,
      limit: query.limit,
    });
    return rows.map(toDeliveryDto);
  }

  @Post('deliveries/:id/replay')
  @Version('1')
  @HttpCode(202)
  async replayDelivery(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentTenant() tenantId: string | null,
    @CurrentUser('id') userId: string,
  ): Promise<WebhookDeliveryDto> {
    this.assertTenant(tenantId);
    await this.endpointsService.assertProTier(tenantId);

    const delivery = await this.deliveriesRepo.findByIdForTenant(id, tenantId);
    if (!delivery) {
      throw new BusinessException(ErrorCode.NOT_FOUND, 'Webhook delivery not found', {
        metadata: { id },
      });
    }

    const reset = await this.deliveriesRepo.resetForReplay(id);
    if (!reset) {
      throw new BusinessException(ErrorCode.NOT_FOUND, 'Webhook delivery not found', {
        metadata: { id },
      });
    }

    void this.audit.logAction({
      action: 'UPDATE',
      resourceType: 'webhook_delivery',
      resourceId: id,
      userId,
      tenantId,
      success: true,
      metadata: { action: 'replay', eventName: reset.eventName },
    });

    // Fire-and-forget direct attempt — the cron sweep would catch
    // it within a minute, but Pro tenants explicitly clicking
    // "Replay" expect immediate action. Errors are persisted by
    // the delivery service itself, so we don't care about the result.
    void this.deliveryService.deliver(reset.id).catch(() => undefined);

    return toDeliveryDto(reset);
  }

  /** Throws 401 if the JWT had no tenantId — defence in depth. */
  private assertTenant(tenantId: string | null): asserts tenantId is string {
    if (!tenantId) {
      throw new BusinessException(
        ErrorCode.TENANT_ACCESS_DENIED,
        'Tenant context is required',
      );
    }
  }
}

function toDeliveryDto(row: {
  id: string;
  endpointId: string;
  eventName: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  lastAttemptAt: Date | null;
  lastError: string | null;
  lastStatusCode: number | null;
  nextRetryAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}): WebhookDeliveryDto {
  return {
    id: row.id,
    endpointId: row.endpointId,
    eventName: row.eventName,
    payload: row.payload,
    status: row.status as DeliveryStatus,
    attempts: row.attempts,
    lastAttemptAt: row.lastAttemptAt ? row.lastAttemptAt.toISOString() : null,
    lastError: row.lastError,
    lastStatusCode: row.lastStatusCode,
    nextRetryAt: row.nextRetryAt ? row.nextRetryAt.toISOString() : null,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
