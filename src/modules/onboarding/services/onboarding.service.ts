import { Injectable } from '@nestjs/common';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { LoggerService } from '@/logging/logger.service';
import { UsersRepository } from '@/modules/auth/repositories/users.repository';

import type { OnboardingRoutingDto } from '../dto/onboarding-routing.dto';
import type { BusinessActivationPreset, OnboardingSegment } from '../types/segment.enum';

/**
 * BE-34 — Onboarding self-selection service.
 *
 * Responsibilities:
 *   1. Persist the user's chosen segment on the `users` table.
 *   2. Compute the routing instruction for the mobile client.
 *   3. Emit an `onboarding_segment_selected` analytics event (stub).
 *
 * Idempotent: re-selection is allowed and simply recomputes routing.
 */
@Injectable()
export class OnboardingService {
  constructor(
    private readonly users: UsersRepository,
    private readonly logger: LoggerService,
  ) {}

  async selectSegment(userId: string, segment: OnboardingSegment): Promise<OnboardingRoutingDto> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new BusinessException(ErrorCode.USER_NOT_FOUND, 'User not found');
    }

    // Persist the segment selection
    await this.users.update(userId, {
      onboardingSegment: segment,
      onboardingSegmentSelectedAt: new Date(),
    });

    // Emit analytics event (stub — real implementation wired in BE-29 integration)
    this.emitAnalyticsEvent(userId, segment);

    // If the user already has a tenant (seeded owner or previously activated),
    // skip business activation and go straight to home.
    if (user.tenantId) {
      return { segment, nextScreen: 'consumer_home', bypassedOnboarding: true };
    }

    return this.routeFor(segment);
  }

  /**
   * Compute the next-screen routing based on the selected segment.
   */
  private routeFor(segment: OnboardingSegment): OnboardingRoutingDto {
    switch (segment) {
      case 'personal':
        return { segment, nextScreen: 'consumer_home', bypassedOnboarding: false };
      case 'parent':
        return {
          segment,
          nextScreen: 'consumer_home_with_allergen_setup',
          bypassedOnboarding: false,
        };
      case 'business_owner':
      case 'pharmacy':
      case 'institution':
        return {
          segment,
          nextScreen: 'business_activation_flow',
          presetForBusinessActivation: segment as BusinessActivationPreset,
          bypassedOnboarding: false,
        };
      case 'auditor_invited':
        return {
          segment,
          nextScreen: 'auditor_invitation_token_entry',
          bypassedOnboarding: false,
        };
    }
  }

  /**
   * Stub analytics event emission.
   * In production this calls the AppAnalyticsService or PostHog SDK.
   */
  private emitAnalyticsEvent(userId: string, segment: OnboardingSegment): void {
    this.logger.info('analytics.onboarding_segment_selected', {
      userId,
      segment,
      timestamp: new Date().toISOString(),
    });
  }
}
