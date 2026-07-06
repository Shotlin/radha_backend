import { Injectable } from '@nestjs/common';

import type {
  CatalogBrowsePage,
  CatalogBrowseQueryDto,
  CatalogCategory,
} from '../dto/consumer-catalog.dto';
import { ConsumerCatalogRepository } from '../repositories/consumer-catalog.repository';

/**
 * Consumer Catalog service — the browse-without-scan read surface.
 *
 * Thin orchestration over {@link ConsumerCatalogRepository}; the repository
 * owns the queries. No writes, no audit log (read-only public-catalog reads),
 * no tenant context (global catalog only).
 */
@Injectable()
export class ConsumerCatalogService {
  constructor(private readonly repo: ConsumerCatalogRepository) {}

  /** Global categories for the Top Categories rail, ordered for display. */
  listCategories(): Promise<CatalogCategory[]> {
    return this.repo.listCategories();
  }

  /** Health-sorted (or alphabetical) page of global-catalog products. */
  browse(query: CatalogBrowseQueryDto): Promise<CatalogBrowsePage> {
    return this.repo.browse(query);
  }
}
