import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Saved Products — create request DTO.
 *
 * Validated by the global `ValidationPipe` (whitelist + transform).
 * Field names mirror the locked API contract exactly so the mobile
 * client can pass through its model JSON without remapping.
 *
 *   - `productName`   required, 1..200 chars (the only mandatory field)
 *   - `productId`     optional, UUID — links to a `products` row when
 *                     the scan resolved against the catalogue
 *   - `barcode`       optional, 8..14 ASCII digits (EAN-8 / UPC-A /
 *                     EAN-13 / GTIN-14 — covers everything we scan)
 *   - `expiresAt`     optional, ISO date `YYYY-MM-DD`
 *   - `notes`         optional, ≤ 500 chars
 *
 * `userId` is intentionally absent — it is sourced from the JWT
 * (`@CurrentUser('id')`) at the controller layer and never trusted
 * from the request body.
 */
export class CreateSavedProductDto {
  @IsString()
  @MinLength(1, { message: 'productName must be at least 1 character' })
  @MaxLength(200, { message: 'productName must be at most 200 characters' })
  productName!: string;

  @IsOptional()
  @IsUUID('4', { message: 'productId must be a valid UUID' })
  productId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{8,14}$/, {
    message: 'barcode must be 8..14 digits',
  })
  barcode?: string;

  @IsOptional()
  @IsDateString(
    { strict: true },
    { message: 'expiresAt must be an ISO date string (YYYY-MM-DD)' },
  )
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'expiresAt must be in YYYY-MM-DD format',
  })
  expiresAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'notes must be at most 500 characters' })
  notes?: string;
}
