import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  Version,
} from '@nestjs/common';

import { ParseUuidPipe } from '@/common/pipes/parse-uuid.pipe';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import {
  CurrentTenant,
  CurrentUser,
  RequireTenant,
  Roles,
} from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '@/modules/auth/guards/permissions.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';
import { TenantScopeGuard } from '@/modules/auth/guards/tenant-scope.guard';

import {
  ListNotificationsQuerySchema,
  type ListNotificationsQueryDto,
  RegisterDeviceTokenSchema,
  type RegisterDeviceTokenDtoSchema,
  TestNotificationSchema,
  type TestNotificationDto,
  UnregisterDeviceTokenSchema,
  type UnregisterDeviceTokenDto,
  UpdatePreferencesSchema,
  type UpdatePreferencesDtoSchema,
} from './dto/notifications.dto';
import { NotificationsService } from './notifications.service';

/**
 * BE-24 — Notifications HTTP surface.
 *
 * Endpoints:
 *   GET    /api/v1/notifications                      List inbox
 *   POST   /api/v1/notifications/:id/read             Mark one read
 *   POST   /api/v1/notifications/read-all             Mark all read
 *   GET    /api/v1/notifications/preferences          Get prefs
 *   PATCH  /api/v1/notifications/preferences          Update prefs
 *   POST   /api/v1/notifications/test                 Admin test send
 *   POST   /api/v1/notifications/fcm-token            Register FCM token
 *   DELETE /api/v1/notifications/fcm-token            Unregister FCM token
 *
 * Static segments are declared before the dynamic `:id` slot so
 * Express's static-first routing keeps `/preferences`, `/read-all`,
 * `/test`, and `/fcm-token` from being mistaken for IDs.
 *
 * BE-08 guard stack runs on every route. `RequireTenant()` is set
 * for the inbox + preferences (so cross-tenant inbox reads are
 * impossible). The FCM-token routes do not require a tenant —
 * a fresh Consumer signup may still be in the BE-09 tenant-bootstrap
 * window when their device first registers.
 */
@Controller('notifications')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, TenantScopeGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /* ───────────────── List + read ───────────────── */

  @Get()
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin', 'consumer')
  @RequireTenant()
  list(
    @Query(new ZodValidationPipe(ListNotificationsQuerySchema))
    query: ListNotificationsQueryDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser('id') userId: string,
  ): Promise<unknown> {
    return this.notifications.getHistory(userId, tenantId, query);
  }

  /* ───────────────── Preferences (static, before :id) ───────────────── */

  @Get('preferences')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin', 'consumer')
  @RequireTenant()
  getPreferences(@CurrentUser('id') userId: string): Promise<unknown> {
    return this.notifications.getPreferences(userId);
  }

  @Patch('preferences')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin', 'consumer')
  @RequireTenant()
  updatePreferences(
    @Body(new ZodValidationPipe(UpdatePreferencesSchema))
    dto: UpdatePreferencesDtoSchema,
    @CurrentUser('id') userId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.notifications.updatePreferences(userId, {
      ...dto,
      tenantId,
    });
  }

  /* ───────────────── Read-all (static, before :id) ───────────────── */

  @Post('read-all')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin', 'consumer')
  @RequireTenant()
  readAll(@CurrentUser('id') userId: string): Promise<unknown> {
    return this.notifications.markAllAsRead(userId);
  }

  /* ───────────────── Admin test send (static) ───────────────── */

  @Post('test')
  @Version('1')
  @HttpCode(202)
  @Roles('admin', 'owner')
  @RequireTenant()
  test(
    @Body(new ZodValidationPipe(TestNotificationSchema)) dto: TestNotificationDto,
    @CurrentTenant() tenantId: string,
  ): Promise<unknown> {
    return this.notifications.send({
      tenantId,
      userId: dto.userId,
      channels: dto.channels,
      category: dto.category,
      subject: dto.subject,
      body: dto.body,
      bodyHtml: dto.bodyHtml,
      priority: dto.priority,
      data: dto.data,
    });
  }

  /* ───────────────── FCM device tokens (static) ───────────────── */

  @Post('fcm-token')
  @Version('1')
  @HttpCode(201)
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin', 'consumer')
  registerFcmToken(
    @Body(new ZodValidationPipe(RegisterDeviceTokenSchema))
    dto: RegisterDeviceTokenDtoSchema,
    @CurrentUser('id') userId: string,
    @CurrentTenant() tenantId: string | null,
  ): Promise<unknown> {
    return this.notifications.registerDeviceToken(userId, tenantId, dto);
  }

  @Delete('fcm-token')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin', 'consumer')
  async unregisterFcmToken(
    @Body(new ZodValidationPipe(UnregisterDeviceTokenSchema))
    dto: UnregisterDeviceTokenDto,
    @CurrentUser('id') userId: string,
  ): Promise<{ success: true }> {
    await this.notifications.unregisterDeviceToken(userId, dto.token);
    return { success: true };
  }

  /* ───────────────── Per-id (last) ───────────────── */

  @Post(':id/read')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin', 'consumer')
  @RequireTenant()
  async markRead(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<{ success: true }> {
    await this.notifications.markAsRead(id, userId);
    return { success: true };
  }
}
