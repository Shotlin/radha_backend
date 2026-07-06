import {
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

import { ParseUuidPipe } from '@/common/pipes/parse-uuid.pipe';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser, Roles } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';
import { AuthenticatedUser } from '@/modules/auth/types/permission.types';

import {
  ExpiryCalendarMonthDto,
  ExpiryCalendarMonthQueryDto,
  ExpiryCalendarMonthQuerySchema,
  MarkConsumedResponseDto,
  RemoveResponseDto,
} from '../dto/expiry-calendar.dto';
import { ExpiryCalendarService } from '../services/expiry-calendar.service';

/**
 * BE-38 — Consumer Expiry Calendar API.
 *
 * Endpoints:
 *   GET  /api/v1/consumer/expiry-calendar?month=YYYY-MM
 *   POST /api/v1/consumer/expiry-calendar/saved-products/:id/consumed
 *   DELETE /api/v1/consumer/expiry-calendar/saved-products/:id
 *
 * Role: consumer only. Premium consumers see family-shared products.
 */
@Controller('consumer/expiry-calendar')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('consumer')
export class ExpiryCalendarController {
  constructor(private readonly svc: ExpiryCalendarService) {}

  @Get()
  @Version('1')
  async byMonth(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(ExpiryCalendarMonthQuerySchema)) query: ExpiryCalendarMonthQueryDto,
  ): Promise<ExpiryCalendarMonthDto> {
    const isPremium = this.isPremiumConsumer(user);
    return this.svc.byMonth(user.id, query.month, isPremium);
  }

  @Post('saved-products/:id/consumed')
  @Version('1')
  @HttpCode(200)
  async markConsumed(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUuidPipe()) id: string,
  ): Promise<MarkConsumedResponseDto> {
    const isPremium = this.isPremiumConsumer(user);
    return this.svc.markConsumed(user.id, id, isPremium);
  }

  @Delete('saved-products/:id')
  @Version('1')
  @HttpCode(200)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUuidPipe()) id: string,
  ): Promise<RemoveResponseDto> {
    const isPremium = this.isPremiumConsumer(user);
    return this.svc.remove(user.id, id, isPremium);
  }

  /** Check if user has premium consumer subscription tier. */
  private isPremiumConsumer(user: AuthenticatedUser): boolean {
    return user.subscriptionTier === 'premium_consumer';
  }
}
