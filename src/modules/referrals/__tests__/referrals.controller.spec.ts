import { ReferralsController } from '../referrals.controller';
import type { ReferralsService } from '../referrals.service';

describe('ReferralsController', () => {
  let controller: ReferralsController;
  let service: jest.Mocked<
    Pick<ReferralsService, 'getMyReferralSummary' | 'applyReferralOnSignup'>
  >;

  beforeEach(() => {
    service = {
      getMyReferralSummary: jest.fn(),
      applyReferralOnSignup: jest.fn(),
    } as unknown as jest.Mocked<
      Pick<ReferralsService, 'getMyReferralSummary' | 'applyReferralOnSignup'>
    >;
    controller = new ReferralsController(service as unknown as ReferralsService);
  });

  it('GET /me delegates to getMyReferralSummary with the caller id', async () => {
    service.getMyReferralSummary.mockResolvedValue({
      code: 'ABCD2345',
      totalReferrals: 0,
      rewardsEarned: 0,
      recentRewards: [],
    });

    const result = await controller.getMine('user-1');

    expect(service.getMyReferralSummary).toHaveBeenCalledWith('user-1');
    expect(result.code).toBe('ABCD2345');
  });

  it('POST /apply forwards the validated DTO to the service', async () => {
    service.applyReferralOnSignup.mockResolvedValue({ applied: true });

    const result = await controller.apply('user-1', { code: 'INVITER1' });

    expect(service.applyReferralOnSignup).toHaveBeenCalledWith('user-1', 'INVITER1');
    expect(result).toEqual({ applied: true });
  });
});
