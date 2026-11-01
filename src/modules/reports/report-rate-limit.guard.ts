import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyInstance } from 'fastify';
import type { AuthedRequest } from '../../common/auth/request-auth.js';
import { ApiError } from '../../common/errors/api.error.js';

type ReportLimiter = ReturnType<FastifyInstance['createRateLimit']>;

// Report routes: 30 requests a minute per member (docs/phase-g1-design.md
// section 4), on top of the global per-IP limit. A controller guard runs after
// the global AuthGuard, so request.auth holds the verified token and the count
// is per membership; it runs before the tenant transaction opens. The limiter
// is the rate-limit plugin's own, set up by configureApp() as reportRateLimit.
// No database and no permission check here (those belong to TenantInterceptor).
@Injectable()
export class ReportRateLimitGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    if (!request.auth) throw new ApiError(401, 'TOKEN_INVALID', 'Please log in again.');
    const limiter = (request.server as unknown as { reportRateLimit: ReportLimiter }).reportRateLimit;
    const result = await limiter(request);
    if (!result.isAllowed && result.isExceeded) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many report requests. Try again later.', {
        'retry-after': String(result.ttlInSeconds),
      });
    }
    return true;
  }
}
