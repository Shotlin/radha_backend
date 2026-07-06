import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';

import { TenantsController } from './tenants.controller';
import { TenantsRepository } from './repositories/tenants.repository';
import { TenantBootstrapService } from './services/tenant-bootstrap.service';
import { TenantOnboardingService } from './services/tenant-onboarding.service';

@Module({
  imports: [AuthModule],
  controllers: [TenantsController],
  providers: [TenantsRepository, TenantOnboardingService, TenantBootstrapService],
  exports: [TenantsRepository, TenantOnboardingService, TenantBootstrapService],
})
export class TenantsModule {}
