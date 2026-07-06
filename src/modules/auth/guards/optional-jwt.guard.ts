import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * Optional JWT guard.
 *
 * If the request carries a valid bearer token, `req.user` is populated
 * exactly the way `JwtAuthGuard` does it. If the request is anonymous,
 * the handler still runs but `req.user` is `undefined`.
 *
 * Used by Public_Product_Profile_Pages (BE-51), Marketing_Website
 * contact form, and a few read-only product endpoints that benefit
 * from richer behaviour for authenticated users without requiring it.
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly inner: JwtAuthGuard) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    if (!req.headers?.['authorization']) return true;
    try {
      await this.inner.canActivate(ctx);
    } catch {
      // Swallow — caller is treated as anonymous.
    }
    return true;
  }
}
