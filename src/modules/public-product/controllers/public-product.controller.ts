import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
  Res,
  Version,
} from '@nestjs/common';
import type { Response } from 'express';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';

import {
  PublicProductQuerySchema,
  type PublicProductQueryDto,
  type PublicProductView,
  SitemapQuerySchema,
  type SitemapQueryDto,
  type SitemapPage,
} from '../dto/public-product.dto';
import { PublicProductService } from '../services/public-product.service';

/**
 * BE-51 — Public Product Profile + Sitemap REST surface.
 *
 *   GET /api/v1/public/products/:slug
 *   GET /api/v1/public/products/sitemap.xml
 *
 * Both endpoints are intentionally **public** — no `JwtAuthGuard`,
 * no `TenantScopeGuard`. They feed the static-build pipeline of the
 * Next.js marketing site, which crawls them at deploy time and on a
 * 24-hour ISR revalidation window.
 *
 * Caching: every successful response carries a long `Cache-Control`
 * so CloudFront / Vercel can serve from edge for 24 h with a 7-day
 * stale-while-revalidate window. The service-level filter on
 * `withdrawn`/`unsafe` rows still applies before the response is
 * built, so a recall today pushes a 410 within `s-maxage` plus
 * however long it takes the CDN's invalidation to fan out.
 *
 * Route order matters: the static `sitemap.xml` segment is declared
 * before the parametric `:slug` route so Express resolves it first.
 */
@Controller('public/products')
export class PublicProductController {
  /**
   * Cache-Control for both the JSON product profile and the sitemap.
   *
   *   - public                  — anyone may cache, no auth varies it
   *   - max-age=3600            — browsers hold for 1h
   *   - s-maxage=86400          — shared caches (CloudFront) hold 24h
   *   - stale-while-revalidate  — CDN may serve stale up to 7d while
   *                               re-fetching in the background
   */
  private static readonly CACHE_CONTROL =
    'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800';

  constructor(private readonly service: PublicProductService) {}

  /**
   * `GET /api/v1/public/products/sitemap.xml`
   *
   * Cursor-paginated. Returns JSON (NOT XML) — the marketing site
   * formats the entries into XML at static-build time. Keeping the
   * API JSON means we don't need an XML serializer here and the
   * endpoint stays trivially testable with `supertest`.
   *
   * Declared BEFORE `@Get(':slug')` so Express matches the static
   * path first.
   */
  @Get('sitemap.xml')
  @Version('1')
  @Header('Cache-Control', PublicProductController.CACHE_CONTROL)
  @Header('X-Content-Type-Options', 'nosniff')
  sitemap(
    @Query(new ZodValidationPipe(SitemapQuerySchema)) query: SitemapQueryDto,
  ): Promise<SitemapPage> {
    return this.service.listSitemap({
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  /**
   * `GET /api/v1/public/products/:slug`
   *
   * Status mapping:
   *   - 200 OK with JSON body for `active` rows,
   *   - 404 Not Found when no product carries the slug,
   *   - 410 Gone with empty body for `withdrawn`/`unsafe` rows
   *     (mapped from the `GoneException` the service throws).
   *
   * Uses `@Res({ passthrough: true })` so we can set headers without
   * losing Nest's response serialisation.
   */
  @Get(':slug')
  @Version('1')
  @Header('Cache-Control', PublicProductController.CACHE_CONTROL)
  @Header('X-Content-Type-Options', 'nosniff')
  async findBySlug(
    @Param('slug') slug: string,
    @Query(new ZodValidationPipe(PublicProductQuerySchema)) _query: PublicProductQueryDto,
    @Res({ passthrough: true }) _res: Response,
  ): Promise<PublicProductView> {
    const product = await this.service.findBySlug(slug);
    if (!product) {
      throw new NotFoundException();
    }
    return product;
  }
}
