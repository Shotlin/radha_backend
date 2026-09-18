import { Body, Controller, HttpCode, Post, UseGuards, Version } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import {
  CurrentUser,
  RequirePermissions,
  RequireTenant,
  Roles,
} from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '@/modules/auth/guards/permissions.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';
import { TenantScopeGuard } from '@/modules/auth/guards/tenant-scope.guard';
import type { AuthenticatedUser } from '@/modules/auth/types/permission.types';

import { VoiceTurnRequestDto, VoiceTurnRequestSchema } from '../dto/voice-assistant.dto';
import { VoiceAssistantService } from '../services/voice-assistant.service';
import { VoiceTurnResult } from '../types/voice.types';

/**
 * Real voice-assistant surface. Registered BEFORE `VoicePlaceholderController`
 * in `VoiceModule.controllers` — both mount at `@Controller('voice')`, and
 * with `VoicePlaceholderController`'s `@All('*')` catch-all, whichever
 * controller's routes are registered first wins the match. Registering this
 * one first means `POST /assistant/turn` reaches the real handler, while
 * every other `/voice/*` path — including future not-yet-built ones — still
 * falls through to the placeholder's honest 503 instead of a bare 404.
 *
 * `tasks:read` is the permission gate: held by owner/manager/staff/admin/
 * auditor, absent from consumer (verified against
 * `role-permissions.map.ts`) — consumer has zero business-data access, so a
 * business voice assistant is inherently unavailable to that role. The app
 * only shows the mic button in business mode anyway; auditor is blocked
 * client-side too (read-only 3-tab shell), this is defense in depth.
 */
@Controller('voice')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, TenantScopeGuard)
export class VoiceAssistantController {
  constructor(private readonly voiceAssistant: VoiceAssistantService) {}

  @Post('assistant/turn')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'admin')
  @RequirePermissions('tasks:read')
  @RequireTenant()
  // Cost per call is near-zero (see AI_OPERATION_UNIT_COST['voice-assistant']),
  // but this stops a stuck client or a "leave the mic on all day" session
  // from hammering the endpoint — the real quota is the daily/monthly
  // AiOperation limit checked inside the service.
  @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
  turn(
    @Body(new ZodValidationPipe(VoiceTurnRequestSchema)) dto: VoiceTurnRequestDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<VoiceTurnResult> {
    return this.voiceAssistant.handleTurn(user, dto);
  }
}
