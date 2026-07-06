import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';

import { InviteMemberDto, InviteMemberSchema } from './dto/invite-member.dto';
import { FamilyMemberDto, FamilyService } from './family.service';

/**
 * BE-36 — Family Sharing REST surface.
 *
 *   GET    /api/v1/family/members          Bearer  List active family members
 *   POST   /api/v1/family/invite           Bearer  Invite by phone number
 *   DELETE /api/v1/family/members/:id      Bearer  Remove a member
 */
@Controller('family')
@UseGuards(JwtAuthGuard)
export class FamilyController {
  constructor(private readonly service: FamilyService) {}

  @Get('members')
  @HttpCode(HttpStatus.OK)
  getMembers(@CurrentUser('id') userId: string): Promise<FamilyMemberDto[]> {
    return this.service.getMembers(userId);
  }

  @Post('invite')
  @HttpCode(HttpStatus.CREATED)
  invite(
    @CurrentUser('id') userId: string,
    @Body(new ZodValidationPipe(InviteMemberSchema)) dto: InviteMemberDto,
  ): Promise<FamilyMemberDto> {
    return this.service.inviteMember(userId, dto.mobile);
  }

  @Delete('members/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser('id') userId: string,
    @Param('id') memberId: string,
  ): Promise<void> {
    return this.service.removeMember(userId, memberId);
  }
}
