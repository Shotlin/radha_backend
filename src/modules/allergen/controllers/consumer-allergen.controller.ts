import { Body, Controller, Get, HttpCode, Param, Put, UseGuards, Version } from "@nestjs/common";
import { JwtAuthGuard } from "@/modules/auth/guards/jwt-auth.guard";
import { CurrentUser } from "@/modules/auth/decorators/auth.decorators";
import { UsersRepository } from "@/modules/auth/repositories/users.repository";
import { z } from "zod";
import { ZodValidationPipe } from "@/common/pipes/zod-validation.pipe";

const AllergenUpdateSchema = z.object({ allergens: z.array(z.string()).default([]) });
type AllergenUpdateDto = z.infer<typeof AllergenUpdateSchema>;

@Controller("allergens/profile")
@UseGuards(JwtAuthGuard)
export class ConsumerAllergenController {
  constructor(private readonly users: UsersRepository) {}

  @Get(":userId")
  @Version("1")
  async getProfile(@Param("userId") userId: string) {
    const tags = await this.users.getAllergenTags(userId);
    return { allergens: tags };
  }

  @Put(":userId")
  @Version("1")
  @HttpCode(200)
  async updateProfile(
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(AllergenUpdateSchema)) dto: AllergenUpdateDto,
    @CurrentUser("id") requesterId: string,
  ) {
    const target = userId === requesterId ? userId : requesterId;
    const tags = await this.users.setAllergenTags(target, dto.allergens);
    return { allergens: tags };
  }
}
