import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
  Version,
} from '@nestjs/common';

import { CurrentUser } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { Quota } from '@/modules/rate-limiting/decorators/quota.decorator';
import { QuotaGuard } from '@/modules/rate-limiting/guards/quota.guard';

import { ParseUuidPipe } from '@/common/pipes/parse-uuid.pipe';

import { CreateSavedProductDto } from './dto/create-saved-product.dto';
import { ListSavedProductsQueryDto } from './dto/list-saved-products.query.dto';
import {
  SavedProductDto,
  SavedProductListResponseDto,
} from './dto/saved-product.dto';
import { SavedProductsService } from './saved-products.service';

/**
 * Saved Products — REST controller (transport only).
 *
 * Locked contract powering FE-16:
 *
 *   GET    /api/v1/saved-products?cursor=&limit=
 *   POST   /api/v1/saved-products
 *   DELETE /api/v1/saved-products/:id
 *
 * `JwtAuthGuard` runs on the class so every endpoint requires a
 * Bearer token. The `userId` is sourced from `@CurrentUser('id')`
 * — never from the request body or path — and pushed into the
 * service as the ownership scope. There is no tenant guard
 * because saved products are a per-user consumer feature; the
 * row's owning user already pins it to a personal tenant via the
 * `users` table.
 *
 * The POST endpoint also wears `@Quota('save')` + `QuotaGuard` so
 * the BE-46 free-consumer cap (5 saved products) is enforced
 * before we touch the database. `QuotaConfigService` already lists
 * `save` as a first-class counter for exactly this surface.
 */
@Controller('saved-products')
@UseGuards(JwtAuthGuard)
export class SavedProductsController {
  constructor(private readonly service: SavedProductsService) {}

  @Get()
  @Version('1')
  list(
    @Query() query: ListSavedProductsQueryDto,
    @CurrentUser('id') userId: string,
  ): Promise<SavedProductListResponseDto> {
    return this.service.list(userId, { cursor: query.cursor, limit: query.limit });
  }

  @Post()
  @Version('1')
  @UseGuards(QuotaGuard)
  @Quota('save')
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body() dto: CreateSavedProductDto,
    @CurrentUser('id') userId: string,
  ): Promise<SavedProductDto> {
    return this.service.create(userId, dto);
  }

  @Delete(':id')
  @Version('1')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUuidPipe()) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.service.delete(userId, id);
  }
}
