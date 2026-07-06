import { BadRequestException, PipeTransform } from '@nestjs/common';
import { ZodError, ZodSchema } from 'zod';

/**
 * Validates an incoming DTO against a Zod schema.
 *
 * On failure throws a `BadRequestException` whose body matches the
 * standard error envelope used by `GlobalExceptionFilter`:
 *
 *   {
 *     "code":    "VALIDATION_ERROR",
 *     "message": "Validation failed",
 *     "details": [
 *       { "field": "...", "message": "...", "code": "..." }
 *     ]
 *   }
 *
 * Usage:
 *
 *   @Post('/x')
 *   create(@Body(new ZodValidationPipe(CreateXDto.schema)) dto: CreateXDto) { ... }
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          details: error.errors.map((err) => ({
            field: err.path.join('.') || '(root)',
            message: err.message,
            code: err.code,
          })),
        });
      }
      throw error;
    }
  }
}
