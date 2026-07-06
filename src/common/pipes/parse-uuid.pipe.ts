import { ArgumentMetadata, BadRequestException, PipeTransform } from '@nestjs/common';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates a path / query parameter as a v1–v5 UUID. We use a regex
 * rather than `class-validator` so this pipe can be used independently
 * of the Zod-based validation chain on bodies.
 */
export class ParseUuidPipe implements PipeTransform<unknown, string> {
  transform(value: unknown, metadata: ArgumentMetadata): string {
    if (typeof value !== 'string' || !UUID_V4_RE.test(value)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `Invalid UUID for parameter "${metadata.data ?? '?'}"`,
        details: [{ field: metadata.data ?? '?', message: 'must be a UUID' }],
      });
    }
    return value;
  }
}
