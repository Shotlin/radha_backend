import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  Version,
} from '@nestjs/common';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser, Roles } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/modules/auth/guards/roles.guard';

import { FamilyAcceptDto, FamilyAcceptSchema } from '../dto/family-accept.dto';
import { FamilyInviteDto, FamilyInviteSchema } from '../dto/family-invite.dto';
import { FamilySharingService } from '../services/family-sharing.service';

/**
 * BE-36 — Family Sharing endpoints.
 *
 * POST   /api/v1/family/invite         Invite member by mobile
 * POST   /api/v1/family/accept         Accept invitation (by invited user)
 * DELETE /api/v1/family/members/:id    Remove member
 * GET    /api/v1/family/members         List members
 */
@Controller('family')
@UseGuards(JwtAuthGuard, RolesGuard)
export class FamilySharingController {
  constructor(private readonly familySharingService: FamilySharingService) {}

  @Post('invite')
  @Version('1')
  @HttpCode(201)
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  async invite(
    @Body(new ZodValidationPipe(FamilyInviteSchema)) dto: FamilyInviteDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.familySharingService.invite(userId, dto.mobile);
  }

  @Post('accept')
  @Version('1')
  @HttpCode(200)
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  async accept(
    @Body(new ZodValidationPipe(FamilyAcceptSchema)) dto: FamilyAcceptDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.familySharingService.accept(dto.inviteId, userId);
  }

  @Delete('members/:id')
  @Version('1')
  @HttpCode(204)
  @Roles('owner', 'manager', 'admin')
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser('id') userId: string,
  ) {
    await this.familySharingService.remove(id, userId);
  }

  @Get('members')
  @Version('1')
  @Roles('owner', 'manager', 'staff', 'auditor', 'admin')
  async listMembers(@CurrentUser('id') userId: string) {
    return this.familySharingService.listMembers(userId);
  }
}
