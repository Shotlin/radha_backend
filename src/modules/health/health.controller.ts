import { Controller, Get, Optional, Version } from '@nestjs/common';

import type { HealthStatusResponse, ReadinessResponse } from '@/shared-types';

import { APP_NAME } from '@/common/constants';
import { DatabaseHealthIndicator } from '@/db/health/database.health-indicator';

/**
 * BE-01 → BE-05 health endpoints.
 *
 * Live (`/health`) — does the process answer? Used by load balancers
 * and platform liveness probes. Stays dependency-free so it can
 * succeed even when downstreams are degraded.
 *
 * Ready (`/health/ready`) — are downstream dependencies healthy
 * enough to receive traffic? BE-05 plugs the database probe in here;
 * BE-32 will add Redis when caching lands.
 */
@Controller('health')
export class HealthController {
  constructor(@Optional() private readonly database?: DatabaseHealthIndicator) {}

  @Get()
  @Version('1')
  liveness(): HealthStatusResponse {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: APP_NAME,
      version: process.env.npm_package_version ?? '1.0.0',
    };
  }

  @Get('ready')
  @Version('1')
  async readiness(): Promise<ReadinessResponse> {
    const checks: Record<string, 'ok' | 'failing' | 'unknown'> = {
      process: 'ok',
    };

    if (this.database) {
      const dbCheck = await this.database.check();
      checks.database = dbCheck.status === 'ok' ? 'ok' : 'failing';
    }
    // BE-32: checks.redis = …

    const overall = Object.values(checks).every((s) => s === 'ok') ? 'ready' : 'not_ready';
    return {
      status: overall,
      timestamp: new Date().toISOString(),
      checks,
    };
  }
}
