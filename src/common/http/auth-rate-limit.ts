import type { FastifyRequest } from 'fastify';

// Per-IP limit for each public auth route (docs/phase-a-design.md section 10).
// Use with @RouteConfig(AUTH_ROUTE_RATE_LIMIT). The number comes from
// AUTH_RATE_LIMIT_MAX, which createApp() puts on the Fastify instance.
export const AUTH_ROUTE_RATE_LIMIT = {
  rateLimit: {
    max: (request: FastifyRequest) =>
      (request.server as unknown as { authRateLimitMax: number }).authRateLimitMax,
    timeWindow: 60_000,
  },
};
