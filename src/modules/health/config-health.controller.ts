import { Controller, ForbiddenException, Get, Version } from '@nestjs/common';

import { ConfigService } from '@/config/config.service';

/**
 * Dev-only debug endpoint that returns the masked process env so a
 * developer can quickly confirm what configuration the server actually
 * loaded. Hard-blocked outside development by an `isProduction` /
 * `isStaging` check.
 */
@Controller('health/config')
export class ConfigHealthController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  @Version('1')
  getMaskedConfig(): Record<string, unknown> {
    if (this.config.isProduction || this.config.isStaging) {
      throw new ForbiddenException('Config endpoint disabled in this environment');
    }
    return {
      nodeEnv: this.config.nodeEnv,
      port: this.config.port,
      apiPrefix: this.config.apiPrefix,
      env: this.config.getAll(),
    };
  }
}
