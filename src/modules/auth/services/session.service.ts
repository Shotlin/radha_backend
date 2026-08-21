import { Injectable } from '@nestjs/common';

import { ConfigService } from '@/config/config.service';

import { SessionsRepository } from '../repositories/sessions.repository';
import { SessionMetadata, SessionRevokeReason } from '../types/auth.types';

@Injectable()
export class SessionService {
  constructor(
    private readonly repo: SessionsRepository,
    private readonly config: ConfigService,
  ) {}

  async create(
    sessionId: string,
    userId: string,
    refreshTokenHash: string,
    metadata: SessionMetadata,
  ): Promise<void> {
    const ttlSec = this.config.jwt.refreshTokenExpirySeconds;
    await this.repo.create({
      id: sessionId,
      userId,
      refreshTokenHash,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent.slice(0, 500),
      deviceId: metadata.deviceId,
      platform: metadata.platform ?? 'mobile',
      isActive: true,
      expiresAt: new Date(Date.now() + ttlSec * 1000),
      lastUsedAt: new Date(),
    });
  }

  findActive(sessionId: string) {
    return this.repo.findActiveById(sessionId);
  }

  revoke(sessionId: string, reason: SessionRevokeReason) {
    return this.repo.revoke(sessionId, reason);
  }

  revokeAllForUser(userId: string, reason: SessionRevokeReason) {
    return this.repo.revokeAllForUser(userId, reason);
  }

  /** Rotates the refresh token hash and slides `expiresAt` forward by the
   * configured TTL from now — see `SessionsRepository.rotateRefreshToken`. */
  rotate(sessionId: string, previousHash: string, newHash: string) {
    const ttlSec = this.config.jwt.refreshTokenExpirySeconds;
    return this.repo.rotateRefreshToken(
      sessionId,
      previousHash,
      newHash,
      new Date(Date.now() + ttlSec * 1000),
    );
  }
}
