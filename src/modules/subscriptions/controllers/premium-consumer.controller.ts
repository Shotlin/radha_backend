import { Body, Controller, Delete, HttpCode, Post, UseGuards, Version } from '@nestjs/common';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { CurrentTenant, CurrentUser, Roles } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';
import { TenantScopeGuard } from '@/modules/auth/guards/tenant-scope.guard';

import { PremiumSubscribeDto, PremiumSubscribeSchema } from '../dto/premium-subscribe.dto';
import { PremiumConsumerService } from '../services/premium-consumer.service';

/**
 * BE-36 — Premium Consumer subscription endpoints.
 *
 * POST   /api/v1/subscriptions/premium-consumer   Subscribe (mock payment gateway)
 * DELETE /api/v1/subscriptions/premium-consumer   Cancel at period end
 */
@Controller('subscriptions/premium-consumer')
@UseGuards(JwtAuthGuard, RolesGuard, TenantScopeGuard)
export class PremiumConsumerController {
  constructor(private readonly premiumConsumerService: PremiumConsumerService) {}

  @Post()
  @Version('1')
  @HttpCode(201)
  @Roles('owner', 'admin')
  async subscribe(
    @Body(new ZodValidationPipe(PremiumSubscribeSchema)) dto: PremiumSubscribeDto,
    @CurrentUser('id') userId: string,
    @CurrentTenant() tenantId: string,
  ) {
    return this.premiumConsumerService.subscribe(userId, tenantId, dto.paymentMethodToken);
  }

  @Delete()
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'admin')
  async cancel(
    @CurrentUser('id') userId: string,
    @CurrentTenant() tenantId: string,
  ) {
    return this.premiumConsumerService.cancel(userId, tenantId);
  }
}
