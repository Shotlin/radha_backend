import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Saved Products — query DTO for `GET /api/v1/saved-products`.
 *
 * Cursor pagination on `(created_at desc, id desc)`. Cursors are
 * opaque base64url strings (capped at 500 chars to defeat oversized
 * payloads on the URL line).
 *
 *   - `limit`   1..50, default 20.
 *   - `cursor`  opaque, optional. When omitted the caller starts at
 *               the most recently saved product.
 *
 * The global `ValidationPipe` is configured with
 * `transform: { enableImplicitConversion: true }`, but we still tag
 * `@Type(() => Number)` explicitly so this DTO compiles and behaves
 * the same way under tests that bypass the pipe.
 */
export class ListSavedProductsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'cursor must be at most 500 characters' })
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer' })
  @Min(1, { message: 'limit must be at least 1' })
  @Max(50, { message: 'limit must be at most 50' })
  limit?: number;
}
