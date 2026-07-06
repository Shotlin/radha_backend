import { Body, Controller, HttpCode, Put, UseGuards, Version } from '@nestjs/common';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser } from '@/modules/auth/decorators/auth.decorators';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '@/modules/auth/types/permission.types';

import {
  UpdateLanguageDto,
  UpdateLanguageResponseDto,
  UpdateLanguageSchema,
} from '../dto/update-language.dto';
import { UserLanguageService } from '../services/user-language.service';

/**
 * BE-42 — PUT /api/v1/users/me/language.
 *
 * Authenticated; transport-only. All business logic lives in the
 * service. The route lives on the `users` namespace per the spec
 * (`/users/me/language`).
 */
@Controller('users/me')
@UseGuards(JwtAuthGuard)
export class UserLanguageController {
  constructor(private readonly svc: UserLanguageService) {}

  @Put('language')
  @Version('1')
  @HttpCode(200)
  async updateLanguage(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(UpdateLanguageSchema)) dto: UpdateLanguageDto,
  ): Promise<UpdateLanguageResponseDto> {
    return this.svc.updatePreferredLanguage(user.id, dto.language);
  }
}
