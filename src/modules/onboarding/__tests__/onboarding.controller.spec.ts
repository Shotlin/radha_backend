import { Test, TestingModule } from '@nestjs/testing';

import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';

import { OnboardingController } from '../controllers/onboarding.controller';
import type { OnboardingRoutingDto } from '../dto/onboarding-routing.dto';
import { OnboardingService } from '../services/onboarding.service';

describe('OnboardingController', () => {
  let controller: OnboardingController;
  let service: jest.Mocked<OnboardingService>;

  beforeEach(async () => {
    const mockService = {
      selectSegment: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OnboardingController],
      providers: [{ provide: OnboardingService, useValue: mockService }],
    })
      // The controller is `@UseGuards(JwtAuthGuard)`; this is a unit test of the
      // controller logic, so bypass the guard (its real auth deps belong in the
      // guard's own spec / e2e, not here).
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<OnboardingController>(OnboardingController);
    service = module.get(OnboardingService) as jest.Mocked<OnboardingService>;
  });

  const mockUser = {
    id: 'user-123',
    tenantId: null,
    role: 'consumer' as const,
    permissions: [] as never[],
    storeIds: [],
    sessionId: 'session-1',
    subscriptionTier: 'free_consumer' as const,
  };

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should call service.selectSegment with userId and segment', async () => {
    const expected: OnboardingRoutingDto = {
      segment: 'personal',
      nextScreen: 'consumer_home',
      bypassedOnboarding: false,
    };
    service.selectSegment.mockResolvedValue(expected);

    const result = await controller.selectSegment(mockUser, { segment: 'personal' });

    expect(service.selectSegment).toHaveBeenCalledWith('user-123', 'personal');
    expect(result).toEqual(expected);
  });

  it('should pass business_owner segment correctly', async () => {
    const expected: OnboardingRoutingDto = {
      segment: 'business_owner',
      nextScreen: 'business_activation_flow',
      presetForBusinessActivation: 'business_owner',
      bypassedOnboarding: false,
    };
    service.selectSegment.mockResolvedValue(expected);

    const result = await controller.selectSegment(mockUser, { segment: 'business_owner' });

    expect(service.selectSegment).toHaveBeenCalledWith('user-123', 'business_owner');
    expect(result).toEqual(expected);
  });

  it('should pass parent segment correctly', async () => {
    const expected: OnboardingRoutingDto = {
      segment: 'parent',
      nextScreen: 'consumer_home_with_allergen_setup',
      bypassedOnboarding: false,
    };
    service.selectSegment.mockResolvedValue(expected);

    const result = await controller.selectSegment(mockUser, { segment: 'parent' });

    expect(service.selectSegment).toHaveBeenCalledWith('user-123', 'parent');
    expect(result).toEqual(expected);
  });

  it('should pass auditor_invited segment correctly', async () => {
    const expected: OnboardingRoutingDto = {
      segment: 'auditor_invited',
      nextScreen: 'auditor_invitation_token_entry',
      bypassedOnboarding: false,
    };
    service.selectSegment.mockResolvedValue(expected);

    const result = await controller.selectSegment(mockUser, { segment: 'auditor_invited' });

    expect(service.selectSegment).toHaveBeenCalledWith('user-123', 'auditor_invited');
    expect(result).toEqual(expected);
  });
});
