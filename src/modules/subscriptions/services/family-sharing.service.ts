import { Injectable, Logger } from '@nestjs/common';

import {
  BusinessException,
  DomainConflictException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';

import { FamilySharingRepository } from '../repositories/family-sharing.repository';
import { FamilySharingMemberRow } from '@/db/schema/family-sharing-members';

/**
 * BE-36 — Family Sharing service.
 *
 * Manages invitations, acceptance, and removal of family members
 * under a Premium Consumer subscription. Up to 5 active members
 * (invited + accepted) are allowed per primary user.
 *
 * Derived entitlements are propagated on acceptance and revoked on
 * removal or primary subscription cancellation.
 */

const MAX_FAMILY_MEMBERS = 5;

@Injectable()
export class FamilySharingService {
  private readonly logger = new Logger(FamilySharingService.name);

  constructor(private readonly familyRepo: FamilySharingRepository) {}

  /**
   * Invite a family member by mobile number.
   *
   * 1. Check max 5 active members limit.
   * 2. Create pending invite row.
   * 3. Send SMS stub (mock).
   */
  async invite(
    primaryUserId: string,
    mobile: string,
  ): Promise<FamilySharingMemberRow> {
    // Enforce 5-member cap
    const activeCount = await this.familyRepo.countActiveMembers(primaryUserId);
    if (activeCount >= MAX_FAMILY_MEMBERS) {
      throw new DomainConflictException(
        `Family sharing limit reached (max ${MAX_FAMILY_MEMBERS} members)`,
        ErrorCode.FAMILY_SHARING_LIMIT_REACHED,
      );
    }

    // Create pending invite
    const inviteExpiresAt = new Date();
    inviteExpiresAt.setHours(inviteExpiresAt.getHours() + 48);

    const row = await this.familyRepo.create({
      primaryUserId,
      invitedMobile: mobile,
      status: 'invited',
      inviteExpiresAt,
    });

    // Mock SMS notification
    this.sendInviteSms(mobile, primaryUserId);

    this.logger.log(
      `Family invite sent: primary=${primaryUserId}, mobile=${mobile}, id=${row.id}`,
    );

    return row;
  }

  /**
   * Accept a family sharing invitation.
   *
   * 1. Validate invitation exists and is pending.
   * 2. Validate invitation has not expired.
   * 3. Mark as accepted and assign member_user_id.
   * 4. Propagate derived entitlements (stub).
   */
  async accept(
    inviteId: string,
    memberUserId: string,
  ): Promise<FamilySharingMemberRow> {
    const invite = await this.familyRepo.findPendingInviteById(inviteId);
    if (!invite) {
      throw new DomainNotFoundException('Family sharing invitation', inviteId);
    }

    // Check expiry
    if (invite.inviteExpiresAt && new Date() > invite.inviteExpiresAt) {
      throw new BusinessException(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'This invitation has expired',
      );
    }

    const accepted = await this.familyRepo.acceptInvite(inviteId, memberUserId);
    if (!accepted) {
      throw new DomainConflictException(
        'Invitation already accepted or removed',
        ErrorCode.CONFLICT,
      );
    }

    // Propagate derived entitlements (stub — in production this would
    // grant the member access to premium features)
    this.propagateEntitlements(memberUserId, invite.primaryUserId);

    this.logger.log(
      `Family invite accepted: id=${inviteId}, member=${memberUserId}, primary=${invite.primaryUserId}`,
    );

    return accepted;
  }

  /**
   * Remove a family member.
   *
   * 1. Mark the member row as 'removed'.
   * 2. Revoke derived entitlements.
   */
  async remove(memberId: string, primaryUserId: string): Promise<void> {
    const removed = await this.familyRepo.removeMember(memberId, primaryUserId);
    if (!removed) {
      throw new DomainNotFoundException('Family member', memberId);
    }

    // Revoke derived entitlements
    if (removed.memberUserId) {
      this.revokeEntitlements(removed.memberUserId);
    }

    this.logger.log(
      `Family member removed: id=${memberId}, primary=${primaryUserId}`,
    );
  }

  /**
   * List active family members for a primary user.
   */
  async listMembers(primaryUserId: string): Promise<FamilySharingMemberRow[]> {
    return this.familyRepo.findByPrimaryUser(primaryUserId);
  }

  /**
   * Revoke all derived entitlements when the primary user cancels
   * their Premium Consumer subscription.
   */
  async revokeAllDerivedFromPrimary(primaryUserId: string): Promise<void> {
    const members = await this.familyRepo.findByPrimaryUser(primaryUserId);
    const revokedCount = await this.familyRepo.revokeAllForPrimary(primaryUserId);

    // Revoke entitlements for each accepted member
    for (const member of members) {
      if (member.memberUserId && member.status === 'accepted') {
        this.revokeEntitlements(member.memberUserId);
      }
    }

    this.logger.log(
      `Revoked all family sharing for primary=${primaryUserId}, count=${revokedCount}`,
    );
  }

  /* ─────────────────── Private helpers ─────────────────── */

  /**
   * Mock SMS send for family invite.
   * In production, this would call the MSG91 integration.
   */
  private sendInviteSms(mobile: string, _primaryUserId: string): void {
    this.logger.log(`[SMS Stub] Family invite SMS sent to ${mobile}`);
  }

  /**
   * Stub: propagate derived entitlements to an accepted member.
   * In production, this would grant the member premium_consumer
   * features via the entitlement system.
   */
  private propagateEntitlements(memberUserId: string, primaryUserId: string): void {
    this.logger.log(
      `[Entitlement Stub] Propagated premium entitlements to member=${memberUserId} from primary=${primaryUserId}`,
    );
  }

  /**
   * Stub: revoke derived entitlements from a removed/downgraded member.
   */
  private revokeEntitlements(memberUserId: string): void {
    this.logger.log(
      `[Entitlement Stub] Revoked derived entitlements for member=${memberUserId}`,
    );
  }
}
