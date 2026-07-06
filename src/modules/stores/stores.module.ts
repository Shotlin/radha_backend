import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { TenantsModule } from '@/modules/tenants/tenants.module';

import { StoreScopeGuard } from './guards/store-scope.guard';
import { StoresRepository } from './repositories/stores.repository';
import { UserStoreAccessRepository } from './repositories/user-store-access.repository';
import { StoresController } from './stores.controller';
import { StoresService } from './stores.service';

@Module({
  imports: [AuthModule, TenantsModule],
  controllers: [StoresController],
  providers: [StoresRepository, UserStoreAccessRepository, StoresService, StoreScopeGuard],
  exports: [StoresRepository, UserStoreAccessRepository, StoresService, StoreScopeGuard],
})
export class StoresModule {}
