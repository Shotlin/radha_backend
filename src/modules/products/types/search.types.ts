import type { ProductRow } from '@/db/schema/products';

export type SearchOrderBy = 'relevance' | 'name' | 'createdAt' | 'popularity';
export type SearchOrderDirection = 'asc' | 'desc';

export interface SearchFilters {
  q?: string;
  ean?: string;
  brand?: string;
  category?: string;
  healthGrade?: ('A' | 'B' | 'C' | 'D' | 'E')[];
  childSafe?: boolean;
  excludeProcessed?: boolean;
  status?: 'active' | 'discontinued' | 'pending_review' | 'rejected';
}

export interface SearchProductHit extends ProductRow {
  rank?: number;
  similarity?: number;
}

export interface SearchResult {
  data: SearchProductHit[];
  total: number;
  nextCursor: string | null;
  facets?: SearchFacets;
  query: string;
  durationMs: number;
}

export interface AutocompleteSuggestion {
  text: string;
  type: 'product' | 'brand' | 'category';
  productId?: string;
  matchedField: 'name' | 'brand' | 'category';
}

export interface AutocompleteResult {
  suggestions: AutocompleteSuggestion[];
  durationMs: number;
}

export interface FacetCount {
  value: string;
  label: string;
  count: number;
}

export interface SearchFacets {
  categories: FacetCount[];
  brands: FacetCount[];
  healthGrades: FacetCount[];
  processingLevels: FacetCount[];
}

export interface SearchAnalyticsEvent {
  query: string;
  tenantId: string | null;
  userId?: string | null;
  resultCount: number;
  durationMs: number;
  source?: 'search' | 'autocomplete';
}
