import { Body, Controller, Get, HttpCode, Post, Req, UseGuards, Version } from '@nestjs/common';
import type { Request } from 'express';

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';

import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/auth.decorators';
import { RefreshTokenDto, RefreshTokenSchema } from './dto/refresh-token.dto';
import { RequestOtpDto, RequestOtpSchema } from './dto/request-otp.dto';
import { VerifyOtpDto, VerifyOtpSchema } from './dto/verify-otp.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import type { UserMeResponse } from './types/auth.types';

/**
 * BE-06 auth surface.
 *
 *   POST /api/v1/auth/otp/request   → issues an OTP via SMS, returns requestId
 *   POST /api/v1/auth/otp/verify    → verifies OTP, returns access + refresh tokens
 *   POST /api/v1/auth/token/refresh → rotates refresh token
 *   GET  /api/v1/auth/me            → current authenticated user (mobile bootstrap)
 *
 * Logout endpoints are added in BE-08 once we have JWT guards in place
 * to extract the active session id from the bearer token.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('otp/request')
  @Version('1')
  @HttpCode(200)
  requestOtp(
    @Body(new ZodValidationPipe(RequestOtpSchema)) dto: RequestOtpDto,
    @Req() req: Request,
  ) {
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    return this.auth.requestOtp(dto, ip);
  }

  @Post('otp/verify')
  @Version('1')
  @HttpCode(200)
  verifyOtp(@Body(new ZodValidationPipe(VerifyOtpSchema)) dto: VerifyOtpDto, @Req() req: Request) {
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const userAgent = req.headers['user-agent'] ?? '';
    return this.auth.verifyOtp(dto, ip, userAgent);
  }

  @Post('token/refresh')
  @Version('1')
  @HttpCode(200)
  refresh(@Body(new ZodValidationPipe(RefreshTokenSchema)) dto: RefreshTokenDto) {
    return this.auth.refreshTokens(dto);
  }

  /**
   * Canonical refresh path used by the mobile client + the Dio auth
   * interceptor (`/api/v1/auth/refresh`). `token/refresh` above is kept as a
   * backward-compatible alias; both rotate the refresh token via the same
   * service call.
   */
  @Post('refresh')
  @Version('1')
  @HttpCode(200)
  refreshAlias(@Body(new ZodValidationPipe(RefreshTokenSchema)) dto: RefreshTokenDto) {
    return this.auth.refreshTokens(dto);
  }

  /**
   * Revokes the caller's current session server-side. The mobile client calls
   * this on sign-out; it also wipes local credentials regardless of the
   * result, so a failure here never traps the user signed-in. Returns 204.
   */
  @Post('logout')
  @Version('1')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  logout(@CurrentUser('sessionId') sessionId: string): Promise<void> {
    return this.auth.logout(sessionId);
  }

  @Get('me')
  @Version('1')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser('id') userId: string): Promise<UserMeResponse> {
    return this.auth.getCurrentUser(userId);
  }
}
