import { Injectable } from '@nestjs/common';
import { JwtService as NestJwtService } from '@nestjs/jwt';

import { BusinessException } from '@/common/errors/business.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ConfigService } from '@/config/config.service';

import { AccessTokenPayload, RefreshTokenPayload } from '../types/auth.types';

/**
 * Thin wrapper around `@nestjs/jwt` that splits sign/verify by token
 * type. Access tokens use a short TTL and the access secret; refresh
 * tokens use a long TTL and a *different* secret so a leaked access
 * token can't forge refresh tokens.
 */
@Injectable()
export class AuthJwtService {
  constructor(
    private readonly jwt: NestJwtService,
    private readonly config: ConfigService,
  ) {}

  async issueAccessToken(payload: AccessTokenPayload): Promise<string> {
    const cfg = this.config.jwt;
    return this.jwt.signAsync(payload, {
      secret: cfg.accessTokenSecret,
      expiresIn: cfg.accessTokenExpirySeconds,
      issuer: cfg.issuer,
      audience: cfg.audience,
    });
  }

  async issueRefreshToken(payload: RefreshTokenPayload): Promise<string> {
    const cfg = this.config.jwt;
    return this.jwt.signAsync(payload, {
      secret: cfg.refreshTokenSecret,
      expiresIn: cfg.refreshTokenExpirySeconds,
      issuer: cfg.issuer,
      audience: cfg.audience,
    });
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    try {
      return await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.jwt.accessTokenSecret,
        issuer: this.config.jwt.issuer,
        audience: this.config.jwt.audience,
      });
    } catch (err) {
      throw this.translate(err, 'access');
    }
  }

  async verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
    try {
      return await this.jwt.verifyAsync<RefreshTokenPayload>(token, {
        secret: this.config.jwt.refreshTokenSecret,
        issuer: this.config.jwt.issuer,
        audience: this.config.jwt.audience,
      });
    } catch (err) {
      throw this.translate(err, 'refresh');
    }
  }

  private translate(err: unknown, kind: 'access' | 'refresh'): BusinessException {
    const message = (err as Error).message ?? 'invalid token';
    if (/expired/i.test(message)) {
      return new BusinessException(
        ErrorCode.TOKEN_EXPIRED,
        kind === 'access' ? 'Access token expired' : 'Refresh token expired',
      );
    }
    return new BusinessException(ErrorCode.TOKEN_INVALID, 'Invalid token');
  }
}
