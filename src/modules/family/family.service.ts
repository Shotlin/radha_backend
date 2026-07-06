import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { FamilyRepository } from './family.repository';

const MAX_FAMILY_MEMBERS = 5;
const INVITE_TTL_HOURS = 48;

export interface FamilyMemberDto {
  id: string;
  mobile: string;
  status: 'invited' | 'accepted' | 'removed' | 'expired';
  memberUserId: string | null;
  invitedAt: string;
  acceptedAt: string | null;
}

@Injectable()
export class FamilyService {
  constructor(private readonly repo: FamilyRepository) {}

  async getMembers(userId: string): Promise<FamilyMemberDto[]> {
    const rows = await this.repo.findActiveMembers(userId);
    return rows.map((r) => ({
      id: r.id,
      mobile: r.invitedMobile,
      status: r.status as FamilyMemberDto['status'],
      memberUserId: r.memberUserId ?? null,
      invitedAt: r.createdAt.toISOString(),
      acceptedAt: r.acceptedAt?.toISOString() ?? null,
    }));
  }

  async inviteMember(primaryUserId: string, mobile: string): Promise<FamilyMemberDto> {
    const count = await this.repo.countActiveMembers(primaryUserId);
    if (count >= MAX_FAMILY_MEMBERS) {
      throw new BadRequestException(
        `Family sharing allows a maximum of ${MAX_FAMILY_MEMBERS} members.`,
      );
    }

    const existing = await this.repo.findExistingInvite(primaryUserId, mobile);
    if (existing) {
      throw new BadRequestException('This number is already in your family group or has a pending invite.');
    }

    const memberUserId = await this.repo.findUserIdByMobile(mobile);

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + INVITE_TTL_HOURS);

    const row = await this.repo.createInvite({
      primaryUserId,
      memberUserId: memberUserId ?? undefined,
      invitedMobile: mobile,
      status: 'invited',
      inviteExpiresAt: expiresAt,
    });

    return {
      id: row.id,
      mobile: row.invitedMobile,
      status: 'invited',
      memberUserId: row.memberUserId ?? null,
      invitedAt: row.createdAt.toISOString(),
      acceptedAt: null,
    };
  }

  async removeMember(primaryUserId: string, memberId: string): Promise<void> {
    const removed = await this.repo.removeMember(memberId, primaryUserId);
    if (!removed) {
      throw new NotFoundException('Family member not found or already removed.');
    }
  }
}
