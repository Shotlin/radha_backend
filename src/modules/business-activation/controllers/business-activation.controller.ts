import { Body, Controller, Get, HttpCode, Post, UseGuards, Version } from '@nestjs/common';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser, Roles } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';
import type { AuthenticatedUser } from '@/modules/auth/types/permission.types';

import { ActivateBusinessSchema, type ActivateBusinessDto } from '../dto/activate-business.dto';
import { BusinessActivationService } from '../services/business-activation.service';
import { TouchpointRulesService } from '../services/touchpoint-rules.service';

/**
 * BE-35 — Business Activation Controller.
 *
 * Transport-only layer. Delegates all business logic to services.
 */
@Controller('account')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BusinessActivationController {
  constructor(
    private readonly activationService: BusinessActivationService,
    private readonly touchpointRules: TouchpointRulesService,
  ) {}

  /**
   * POST /api/v1/account/activate-business
   *
   * Upgrades the current user to Owner with a new business tenant and store.
   * Accepts consumers (normal sign-up flow) and owners seeded without a tenant.
   */
  @Post('activate-business')
  @Roles('consumer', 'owner')
  @Version('1')
  @HttpCode(201)
  async activateBusiness(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(ActivateBusinessSchema)) dto: ActivateBusinessDto,
  ) {
    return this.activationService.activate({ userId: user.id, ...dto });
  }

  /**
   * GET /api/v1/account/touchpoints
   *
   * Returns which business-activation touchpoints should be displayed
   * to the current Consumer user.
   */
  @Get('touchpoints')
  @Roles('consumer')
  @Version('1')
  @HttpCode(200)
  async getTouchpoints(@CurrentUser() user: AuthenticatedUser) {
    return this.touchpointRules.evaluate(user.id);
  }
}
