import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';

import { ShoppingListController } from './controllers/shopping-list.controller';
import { ShoppingListItemRepository } from './repositories/shopping-list-item.repository';
import { ShoppingListRepository } from './repositories/shopping-list.repository';
import { ShoppingListService } from './services/shopping-list.service';
import { WhatsAppFormatterService } from './services/whatsapp-formatter.service';

/**
 * BE-55 — Shopping List module.
 *
 * Wires the per-user, text-input shopping list with optional WhatsApp
 * share (Req 47, voice deferred to v2 per Req 36).
 *
 *   - `ShoppingListController` → `/api/v1/shopping-lists/*`
 *   - `ShoppingListService`    → CRUD + 100-item-per-list cap
 *   - `WhatsAppFormatterService` → text + `wa.me` share URL builder
 *   - Two thin Drizzle repositories for the parent list and items.
 *
 * Imports `AuthModule` so `JwtAuthGuard` resolves on the controller
 * (every endpoint is authenticated; ownership enforcement happens
 * inside the service via `userId`).
 *
 * Per the BE-55 spec this module is NOT registered in
 * `app.module.ts` — that wiring lands in the BE-55 handoff doc.
 */
@Module({
  imports: [AuthModule],
  controllers: [ShoppingListController],
  providers: [
    ShoppingListRepository,
    ShoppingListItemRepository,
    WhatsAppFormatterService,
    ShoppingListService,
  ],
  exports: [ShoppingListService, WhatsAppFormatterService],
})
export class ShoppingListModule {}
