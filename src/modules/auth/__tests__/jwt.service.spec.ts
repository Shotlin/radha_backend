import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';

import { AuthJwtService } from '../services/jwt.service';

const fakeConfig = {
  jwt: {
    accessTokenSecret: 'a'.repeat(40),
    refreshTokenSecret: 'b'.repeat(40),
    accessTokenExpirySeconds: 3,
    refreshTokenExpirySeconds: 60,
    issuer: 'radha-test',
    audience: 'radha-test-clients',
  },
} as unknown as ConfigService;

describe('AuthJwtService', () => {
  let svc: AuthJwtService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: fakeConfig.jwt.accessTokenSecret })],
      providers: [AuthJwtService, { provide: ConfigService, useValue: fakeConfig }],
    }).compile();
    svc = moduleRef.get(AuthJwtService);
  });

  it('round-trips an access token', async () => {
    const token = await svc.issueAccessToken({
      sub: 'u-1',
      tenantId: 't-1',
      role: 'consumer',
      sessionId: 's-1',
    });
    const payload = await svc.verifyAccessToken(token);
    expect(payload).toMatchObject({
      sub: 'u-1',
      tenantId: 't-1',
      role: 'consumer',
      sessionId: 's-1',
      iss: 'radha-test',
    });
  });

  it('rejects an access token signed with the refresh secret', async () => {
    const refresh = await svc.issueRefreshToken({ sub: 'u-1', sessionId: 's-1', jti: 'j-1' });
    await expect(svc.verifyAccessToken(refresh)).rejects.toMatchObject({
      code: ErrorCode.TOKEN_INVALID,
    });
  });

  it('reports TOKEN_EXPIRED for a token whose ttl has elapsed', async () => {
    const token = await svc.issueAccessToken({
      sub: 'u-1',
      tenantId: null,
      role: 'consumer',
      sessionId: 's-1',
    });
    await new Promise((r) => setTimeout(r, 4_000));
    try {
      await svc.verifyAccessToken(token);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as BusinessException).code).toBe(ErrorCode.TOKEN_EXPIRED);
    }
  }, 8_000);

  it('rejects a refresh token signed with the access secret', async () => {
    const access = await svc.issueAccessToken({
      sub: 'u-1',
      tenantId: null,
      role: 'consumer',
      sessionId: 's-1',
    });
    await expect(svc.verifyRefreshToken(access)).rejects.toMatchObject({
      code: ErrorCode.TOKEN_INVALID,
    });
  });
});
