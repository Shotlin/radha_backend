import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
  Version,
} from '@nestjs/common';

import { ParseUuidPipe } from '@/common/pipes/parse-uuid.pipe';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';

import {
  AddShoppingListItemDto,
  AddShoppingListItemSchema,
  UpdateShoppingListItemDto,
  UpdateShoppingListItemSchema,
} from '../dto/add-item.dto';
import {
  CreateShoppingListDto,
  CreateShoppingListSchema,
  UpdateShoppingListDto,
  UpdateShoppingListSchema,
} from '../dto/create-list.dto';
import {
  WhatsAppFormatDto,
  WhatsAppFormatResponseDto,
  WhatsAppFormatSchema,
} from '../dto/whatsapp-format.dto';
import {
  ShoppingListDetailDto,
  ShoppingListItemDto,
  ShoppingListService,
  ShoppingListSummaryDto,
} from '../services/shopping-list.service';

/**
 * BE-55 — Shopping List REST controller.
 *
 * Endpoints (all under `/api/v1/shopping-lists`):
 *   POST   /shopping-lists                                  Create
 *   GET    /shopping-lists                                  List active
 *   GET    /shopping-lists/:id                              Detail (with items)
 *   PATCH  /shopping-lists/:id                              Rename / archive
 *   POST   /shopping-lists/:id/items                        Add item
 *   PATCH  /shopping-lists/:id/items/:itemId                Toggle / update
 *   DELETE /shopping-lists/:id/items/:itemId                Soft-delete
 *   POST   /shopping-lists/:id/whatsapp-format              `{ text, shareUrl }`
 *
 * Transport only — every route resolves through `ShoppingListService`.
 * `JwtAuthGuard` runs on the class, so all endpoints require a Bearer
 * token. Tenant scoping is intentionally absent because shopping
 * lists are a per-user consumer feature; ownership is enforced inside
 * the service layer using `userId`.
 */
@Controller('shopping-lists')
@UseGuards(JwtAuthGuard)
export class ShoppingListController {
  constructor(private readonly service: ShoppingListService) {}

  @Post()
  @Version('1')
  create(
    @Body(new ZodValidationPipe(CreateShoppingListSchema)) dto: CreateShoppingListDto,
    @CurrentUser('id') userId: string,
  ): Promise<ShoppingListSummaryDto> {
    return this.service.createList(userId, dto);
  }

  @Get()
  @Version('1')
  list(@CurrentUser('id') userId: string): Promise<ShoppingListSummaryDto[]> {
    return this.service.listForUser(userId);
  }

  @Get(':id')
  @Version('1')
  get(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<ShoppingListDetailDto> {
    return this.service.getListWithItems(id, userId);
  }

  @Patch(':id')
  @Version('1')
  update(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(UpdateShoppingListSchema)) dto: UpdateShoppingListDto,
    @CurrentUser('id') userId: string,
  ): Promise<ShoppingListSummaryDto> {
    return this.service.updateList(id, userId, dto);
  }

  @Post(':id/items')
  @Version('1')
  addItem(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(AddShoppingListItemSchema)) dto: AddShoppingListItemDto,
    @CurrentUser('id') userId: string,
  ): Promise<ShoppingListItemDto> {
    return this.service.addItem(id, userId, dto);
  }

  @Patch(':id/items/:itemId')
  @Version('1')
  updateItem(
    @Param('id', new ParseUuidPipe()) id: string,
    @Param('itemId', new ParseUuidPipe()) itemId: string,
    @Body(new ZodValidationPipe(UpdateShoppingListItemSchema)) dto: UpdateShoppingListItemDto,
    @CurrentUser('id') userId: string,
  ): Promise<ShoppingListItemDto> {
    return this.service.updateItem(id, itemId, userId, dto);
  }

  @Delete(':id/items/:itemId')
  @Version('1')
  @HttpCode(200)
  deleteItem(
    @Param('id', new ParseUuidPipe()) id: string,
    @Param('itemId', new ParseUuidPipe()) itemId: string,
    @CurrentUser('id') userId: string,
  ): Promise<{ id: string; deleted: true }> {
    return this.service.deleteItem(id, itemId, userId);
  }

  @Post(':id/whatsapp-format')
  @Version('1')
  @HttpCode(200)
  formatForWhatsApp(
    @Param('id', new ParseUuidPipe()) id: string,
    @Body(new ZodValidationPipe(WhatsAppFormatSchema)) dto: WhatsAppFormatDto,
    @CurrentUser('id') userId: string,
  ): Promise<WhatsAppFormatResponseDto> {
    return this.service.formatForWhatsApp(id, userId, dto);
  }
}
