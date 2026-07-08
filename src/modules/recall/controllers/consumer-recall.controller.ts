import { Controller, Get, UseGuards, Version } from "@nestjs/common";

import { CurrentUser } from "@/modules/auth/decorators/auth.decorators";
import { JwtAuthGuard } from "@/modules/auth/guards/jwt-auth.guard";
import type { AuthenticatedUser } from "@/modules/auth/types/permission.types";

import { RecallService } from "../services/recall.service";

/**
 * Consumer-facing recall alerts endpoint at /recalls — matches the Flutter
 * api_client path. Returns empty list when the user has no tenantId (new
 * consumer accounts without saved products yet).
 */
@Controller("recalls")
@UseGuards(JwtAuthGuard)
export class ConsumerRecallController {
  constructor(private readonly svc: RecallService) {}

  @Get()
  @Version("1")
  async listAlerts(@CurrentUser() user: AuthenticatedUser) {
    if (!user.tenantId) return [];
    const result = await this.svc.listAlerts(user.id, user.tenantId, { limit: 50 });
    return result.data ?? [];
  }
}
