import { OnboardingService } from '../services/onboarding.service';

describe('OnboardingService', () => {
  let service: OnboardingService;
  let mockUsersRepo: {
    findById: jest.Mock;
    update: jest.Mock;
  };
  let mockLogger: {
    info: jest.Mock;
    error: jest.Mock;
    warn: jest.Mock;
    debug: jest.Mock;
  };

  beforeEach(() => {
    mockUsersRepo = {
      findById: jest.fn(),
      update: jest.fn(),
    };
    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    };

    service = new OnboardingService(mockUsersRepo as never, mockLogger as never);
  });

  const mockUser = {
    id: 'user-123',
    tenantId: 'tenant-1',
    mobile: '+919876543210',
    name: 'Test User',
    role: 'consumer',
    onboardingSegment: null,
    onboardingSegmentSelectedAt: null,
    isActive: true,
  };

  describe('selectSegment', () => {
    beforeEach(() => {
      mockUsersRepo.findById.mockResolvedValue(mockUser);
      mockUsersRepo.update.mockResolvedValue({ ...mockUser, onboardingSegment: 'personal' });
    });

    // T1: personal → consumer_home
    it('should route "personal" to consumer_home', async () => {
      const result = await service.selectSegment('user-123', 'personal');

      expect(result).toEqual({
        segment: 'personal',
        nextScreen: 'consumer_home',
        bypassedOnboarding: false,
      });
    });

    // T2: parent → consumer_home_with_allergen_setup
    it('should route "parent" to consumer_home_with_allergen_setup', async () => {
      const result = await service.selectSegment('user-123', 'parent');

      expect(result).toEqual({
        segment: 'parent',
        nextScreen: 'consumer_home_with_allergen_setup',
        bypassedOnboarding: false,
      });
    });

    // T3: business_owner → business_activation_flow with preset
    it('should route "business_owner" to business_activation_flow with preset', async () => {
      const result = await service.selectSegment('user-123', 'business_owner');

      expect(result).toEqual({
        segment: 'business_owner',
        nextScreen: 'business_activation_flow',
        presetForBusinessActivation: 'business_owner',
        bypassedOnboarding: false,
      });
    });

    // T4: pharmacy → business_activation_flow with preset pharmacy
    it('should route "pharmacy" to business_activation_flow with preset pharmacy', async () => {
      const result = await service.selectSegment('user-123', 'pharmacy');

      expect(result).toEqual({
        segment: 'pharmacy',
        nextScreen: 'business_activation_flow',
        presetForBusinessActivation: 'pharmacy',
        bypassedOnboarding: false,
      });
    });

    // T5: institution → business_activation_flow with preset institution
    it('should route "institution" to business_activation_flow with preset institution', async () => {
      const result = await service.selectSegment('user-123', 'institution');

      expect(result).toEqual({
        segment: 'institution',
        nextScreen: 'business_activation_flow',
        presetForBusinessActivation: 'institution',
        bypassedOnboarding: false,
      });
    });

    // T6: auditor_invited → auditor_invitation_token_entry
    it('should route "auditor_invited" to auditor_invitation_token_entry', async () => {
      const result = await service.selectSegment('user-123', 'auditor_invited');

      expect(result).toEqual({
        segment: 'auditor_invited',
        nextScreen: 'auditor_invitation_token_entry',
        bypassedOnboarding: false,
      });
    });

    // T9: DB column onboarding_segment is set
    it('should persist onboarding_segment to the users table', async () => {
      await service.selectSegment('user-123', 'personal');

      expect(mockUsersRepo.update).toHaveBeenCalledWith('user-123', {
        onboardingSegment: 'personal',
        onboardingSegmentSelectedAt: expect.any(Date),
      });
    });

    // T10: DB column onboarding_segment_selected_at is set
    it('should persist onboarding_segment_selected_at as current timestamp', async () => {
      const before = Date.now();
      await service.selectSegment('user-123', 'business_owner');
      const after = Date.now();

      const updateCall = mockUsersRepo.update.mock.calls[0][1];
      const timestamp = updateCall.onboardingSegmentSelectedAt.getTime();
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });

    // T11: Analytics event is emitted
    it('should emit onboarding_segment_selected analytics event', async () => {
      await service.selectSegment('user-123', 'parent');

      expect(mockLogger.info).toHaveBeenCalledWith('analytics.onboarding_segment_selected', {
        userId: 'user-123',
        segment: 'parent',
        timestamp: expect.any(String),
      });
    });

    // T12: Idempotent — calling twice returns same routing
    it('should be idempotent — re-selecting returns same routing', async () => {
      mockUsersRepo.findById.mockResolvedValue({
        ...mockUser,
        onboardingSegment: 'personal',
        onboardingSegmentSelectedAt: new Date(),
      });

      const result = await service.selectSegment('user-123', 'personal');

      expect(result.nextScreen).toBe('consumer_home');
      expect(result.segment).toBe('personal');
    });

    // User not found
    it('should throw when user is not found', async () => {
      mockUsersRepo.findById.mockResolvedValue(null);

      await expect(service.selectSegment('nonexistent', 'personal')).rejects.toThrow();
    });
  });
});
