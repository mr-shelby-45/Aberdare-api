import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from '../../common/auth/public.decorator.js';
import type { AuthedRequest } from '../../common/auth/request-auth.js';
import { ApiError } from '../../common/errors/api.error.js';
import { AccessTokenService } from './access-token.service.js';

// Global guard (docs/phase-a-design.md section 8, step 2). Checks the access
// token only: signature, expiry, audience. It never touches the database:
// guards run before the tenant transaction exists, so membership status and
// permissions are checked by the TenantInterceptor instead.
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9._-]+)$/.exec(header) : null;
    if (!match) throw new ApiError(401, 'TOKEN_INVALID', 'Please log in again.');
    request.auth = await this.accessTokens.verify(match[1]);
    return true;
  }
}
