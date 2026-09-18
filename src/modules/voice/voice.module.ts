import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { ExpiryModule } from '@/modules/expiry/expiry.module';
import { InventoryModule } from '@/modules/inventory/inventory.module';
import { TasksModule } from '@/modules/tasks/tasks.module';

import { VoiceAssistantController } from './controllers/voice-assistant.controller';
import { VoicePlaceholderController } from './controllers/voice-placeholder.controller';
import { BusinessSnapshotService } from './services/business-snapshot.service';
import { VoiceAssistantService } from './services/voice-assistant.service';

/**
 * Voice module. Originally BE-57 reserved the `/api/v1/voice/*` namespace
 * with a single placeholder controller (`VoicePlaceholderController`) that
 * 503s every path — its own doc said "v2 will replace the placeholder with
 * real controllers without renaming the route." This is that replacement,
 * landing incrementally: `VoiceAssistantController` now serves the real
 * `POST /assistant/turn` endpoint; the placeholder stays registered
 * *second* as a catch-all, so any other `/voice/*` path (including ones
 * from a later phase not yet built) still 503s honestly instead of 404ing.
 * See `VoiceAssistantController`'s doc comment for why registration order
 * matters here.
 *
 * (Note: despite an earlier version of this file's comment claiming
 * otherwise, `VoiceModule` IS already registered in `app.module.ts` —
 * confirmed by grep before writing this. That comment was simply stale.)
 *
 * Imports:
 *   - `AuthModule` → guards + `PermissionsService` (the store-access check
 *     `VoiceAssistantService` uses).
 *   - `ExpiryModule` / `TasksModule` / `InventoryModule` → the three
 *     services `BusinessSnapshotService` calls in-process to build the
 *     answer's data snapshot (`GET /api/v1/dashboard/kpis` looked like the
 *     obvious source but its module is never imported anywhere — dead
 *     code — so this goes straight to the real, registered services
 *     instead of a live HTTP self-call to a route that doesn't exist).
 *   - `LlmService` / `UsageTrackerService` need no explicit import —
 *     `AiModule` is `@Global()`.
 */
@Module({
  imports: [AuthModule, ExpiryModule, TasksModule, InventoryModule],
  controllers: [VoiceAssistantController, VoicePlaceholderController],
  providers: [BusinessSnapshotService, VoiceAssistantService],
})
export class VoiceModule {}
