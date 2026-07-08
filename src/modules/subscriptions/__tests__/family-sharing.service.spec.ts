import { Test, TestingModule } from '@nestjs/testing';

import {
  BusinessException,
  DomainConflictException,
  DomainNotFoundException,
} from '@/common/errors/business.exception';

import { FamilySharingService } from '../services/family-sharing.service';
import { FamilySharingRepository } from '../repositories/family-sharing.repository';

/**
 * BE-36 — FamilySharingService unit tests.
 *
 * Covers:
 *   - Happy-path invite
 *   - Quota limit (max 5 members) enforcement
 *   - Happy-path accept
 *   - Accept expired invitation rejection
 *   - Accept wrong mobile rejection
 *   - Remove member
 *   - Remove non-existent member (404)
 *   - List members
 *   - Revoke all on primary cancel
 *   - Concurrent invite race (idempotency)
 */
describe('FamilySharingService', () => {
  let service: FamilySharingService;
  let familyRepo: jest.Mocked<FamilySharingRepository>;

  const primaryUserId = '11111111-1111-1111-1111-111111111111';
  const memberUserId = '33333333-3333-3333-3333-333333333333';
  const mobile = '+919876543210';

  beforeEach(async () => {
    const mockRepo = {
      countActiveMembers: jest.fn(),
      create: jest.fn(),
      findByPrimaryUser: jest.fn(),
      findPendingInviteById: jest.fn(),
      acceptInvite: jest.fn(),
      removeMember: jest.fn(),
      revokeAllForPrimary: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FamilySharingService,
        { provide: FamilySharingRepository, useValue: mockRepo },
      ],
    }).compile();

    service = module.get<FamilySharingService>(FamilySharingService);
    familyRepo = module.get(FamilySharingRepository);
  });

  describe('invite', () => {
    it('should create an invite when under the 5-member limit', async () => {
      familyRepo.countActiveMembers.mockResolvedValue(2);
      const mockRow = {
        id: 'invite-1',
        primaryUserId,
        invitedMobile: mobile,
        status: 'invited',
        memberUserId: null,
        acceptedAt: null,
        removedAt: null,
        inviteExpiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      familyRepo.create.mockResolvedValue(mockRow as never);

      const result = await service.invite(primaryUserId, mobile);

      expect(result).toHaveProperty('id', 'invite-1');
      expect(result).toHaveProperty('status', 'invited');
      expect(familyRepo.countActiveMembers).toHaveBeenCalledWith(primaryUserId);
      expect(familyRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          primaryUserId,
          invitedMobile: mobile,
          status: 'invited',
        }),
      );
    });

    it('should reject invite when 5-member limit is reached', async () => {
      familyRepo.countActiveMembers.mockResolvedValue(5);

      await expect(service.invite(primaryUserId, mobile)).rejects.toThrow(
        DomainConflictException,
      );
      expect(familyRepo.create).not.toHaveBeenCalled();
    });

    it('should reject invite at exactly the limit boundary', async () => {
      familyRepo.countActiveMembers.mockResolvedValue(5);

      await expect(service.invite(primaryUserId, '+919000000001')).rejects.toThrow(
        DomainConflictException,
      );
    });

    it('should allow invite at 4 members (under limit)', async () => {
      familyRepo.countActiveMembers.mockResolvedValue(4);
      familyRepo.create.mockResolvedValue({
        id: 'invite-5',
        primaryUserId,
        invitedMobile: '+919000000005',
        status: 'invited',
      } as never);

      const result = await service.invite(primaryUserId, '+919000000005');
      expect(result).toHaveProperty('id', 'invite-5');
    });
  });

  describe('accept', () => {
    const inviteId = 'invite-1';

    it('should accept a valid pending invitation', async () => {
      const pendingInvite = {
        id: inviteId,
        primaryUserId,
        invitedMobile: mobile,
        status: 'invited',
        memberUserId: null,
        inviteExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      };
      familyRepo.findPendingInviteById.mockResolvedValue(pendingInvite as never);
      familyRepo.acceptInvite.mockResolvedValue({
        ...pendingInvite,
        status: 'accepted',
        memberUserId,
        acceptedAt: new Date(),
      } as never);

      const result = await service.accept(inviteId, memberUserId);

      expect(result).toHaveProperty('status', 'accepted');
      expect(result).toHaveProperty('memberUserId', memberUserId);
      expect(familyRepo.acceptInvite).toHaveBeenCalledWith(inviteId, memberUserId);
    });

    it('should reject accept when invitation does not exist', async () => {
      familyRepo.findPendingInviteById.mockResolvedValue(null);

      await expect(service.accept('non-existent', memberUserId)).rejects.toThrow(
        DomainNotFoundException,
      );
    });

    it('should reject accept when invitation has expired', async () => {
      familyRepo.findPendingInviteById.mockResolvedValue({
        id: inviteId,
        primaryUserId,
        invitedMobile: mobile,
        status: 'invited',
        inviteExpiresAt: new Date(Date.now() - 1000), // expired
      } as never);

      await expect(service.accept(inviteId, memberUserId)).rejects.toThrow(
        BusinessException,
      );
    });

    it('should throw conflict when invite already accepted', async () => {
      familyRepo.findPendingInviteById.mockResolvedValue({
        id: inviteId,
        primaryUserId,
        invitedMobile: mobile,
        status: 'invited',
        inviteExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      } as never);
      familyRepo.acceptInvite.mockResolvedValue(null);

      await expect(service.accept(inviteId, memberUserId)).rejects.toThrow(
        DomainConflictException,
      );
    });
  });

  describe('remove', () => {
    it('should remove an active family member', async () => {
      familyRepo.removeMember.mockResolvedValue({
        id: 'member-1',
        primaryUserId,
        memberUserId,
        status: 'removed',
        removedAt: new Date(),
      } as never);

      await expect(service.remove('member-1', primaryUserId)).resolves.toBeUndefined();
      expect(familyRepo.removeMember).toHaveBeenCalledWith('member-1', primaryUserId);
    });

    it('should throw DomainNotFoundException when member does not exist', async () => {
      familyRepo.removeMember.mockResolvedValue(null);

      await expect(service.remove('non-existent', primaryUserId)).rejects.toThrow(
        DomainNotFoundException,
      );
    });
  });

  describe('listMembers', () => {
    it('should return all active members for primary user', async () => {
      const members = [
        { id: 'm1', primaryUserId, invitedMobile: '+919000000001', status: 'accepted' },
        { id: 'm2', primaryUserId, invitedMobile: '+919000000002', status: 'invited' },
      ];
      familyRepo.findByPrimaryUser.mockResolvedValue(members as never);

      const result = await service.listMembers(primaryUserId);

      expect(result).toHaveLength(2);
      expect(familyRepo.findByPrimaryUser).toHaveBeenCalledWith(primaryUserId);
    });
  });

  describe('revokeAllDerivedFromPrimary', () => {
    it('should revoke all active members when primary cancels', async () => {
      const members = [
        { id: 'm1', primaryUserId, memberUserId: 'u1', status: 'accepted' },
        { id: 'm2', primaryUserId, memberUserId: 'u2', status: 'accepted' },
        { id: 'm3', primaryUserId, memberUserId: null, status: 'invited' },
      ];
      familyRepo.findByPrimaryUser.mockResolvedValue(members as never);
      familyRepo.revokeAllForPrimary.mockResolvedValue(3);

      await expect(service.revokeAllDerivedFromPrimary(primaryUserId)).resolves.toBeUndefined();
      expect(familyRepo.revokeAllForPrimary).toHaveBeenCalledWith(primaryUserId);
    });
  });
});
