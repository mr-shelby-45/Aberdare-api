import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import {
  ConsoleLogger,
  Module,
  type Type,
  ValidationPipe,
  type ValidationError,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { randomBytes } from 'node:crypto';
import type { Writable } from 'node:stream';
import { CoreModule } from './common/core.module.js';
import { ApiError } from './common/errors/api.error.js';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter.js';
import { loggerOptions } from './common/logging/logger.options.js';
import { RequestLogController } from './common/logging/request-log.controller.js';
import type { AuthedRequest } from './common/auth/request-auth.js';
import { type AppConfig, REPORT_RATE_LIMIT_MAX, REPORT_RATE_LIMIT_WINDOW_MS } from './config/app.config.js';

export interface CreateAppOptions {
  // Where request log lines go (tests capture them). Default: stdout.
  logStream?: Writable;
  // Nest's own startup lines. Tests turn them off to keep output readable.
  nestLogs?: boolean;
}

/** The root module plus CoreModule (config, clock, hashers), available everywhere. */
export function withCore(rootModule: Type<unknown>, config: AppConfig): Type<unknown> {
  @Module({ imports: [CoreModule.forRoot(config), rootModule] })
  class AppRoot {}
  return AppRoot;
}

/** Fastify with proxy trust, server-generated request IDs and one JSON log line per request. */
export function createAdapter(config: AppConfig, options: CreateAppOptions = {}): FastifyAdapter {
  return new FastifyAdapter({
    // 1 MiB, Fastify's own default, stated so an upgrade cannot change it
    // silently. POST /v1/sync/commands relies on it (docs/phase-b-design.md
    // section 5); a bigger body gets 413 PAYLOAD_TOO_LARGE.
    bodyLimit: 1_048_576,
    // Empty list = trust no proxy: request.ip is the socket address.
    trustProxy: config.trustProxy.length > 0 ? config.trustProxy : false,
    // Never taken from an incoming header.
    requestIdHeader: false,
    genReqId: () => `req_${randomBytes(9).toString('base64url')}`,
    logger: loggerOptions(config.logLevel, options.logStream),
    logController: new RequestLogController(),
  });
}

/** Security headers, rate limits, the error shape and validation; then starts the app. */
export async function configureApp(app: NestFastifyApplication, config: AppConfig): Promise<void> {
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });
  // Read by AUTH_ROUTE_RATE_LIMIT on each public auth route.
  fastify.decorate('authRateLimitMax', config.authRateLimitMax);

  await app.register(helmet);
  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    // Becomes a 429 that AllExceptionsFilter turns into the standard shape.
    errorResponseBuilder: () => ({ statusCode: 429, message: 'Too many requests' }),
  });
  // Phase G1: the per-member report limit, checked by ReportRateLimitGuard
  // after the token is verified (route settings run before that, so they
  // could only count per IP). Its own in-memory store, like the global limit's.
  fastify.decorate(
    'reportRateLimit',
    fastify.createRateLimit({
      max: REPORT_RATE_LIMIT_MAX,
      timeWindow: REPORT_RATE_LIMIT_WINDOW_MS,
      keyGenerator: (request) => `report:${(request as AuthedRequest).auth?.membershipId ?? ''}`,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      exceptionFactory: (errors: ValidationError[]) =>
        new ApiError(
          422,
          'VALIDATION_FAILED',
          // Field names only, never the submitted values.
          `Invalid fields: ${errors.map((e) => e.property).join(', ')}`,
        ),
    }),
  );

  await app.init();
  await fastify.ready();
}

/**
 * Builds the HTTP app exactly as production runs it. Used by main.ts; tests
 * build the same app from the same pieces (test/helpers/app.ts).
 */
export async function createApp(
  rootModule: Type<unknown>,
  config: AppConfig,
  options: CreateAppOptions = {},
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    withCore(rootModule, config),
    createAdapter(config, options),
    {
      // Exact request bytes on req.rawBody, for webhook verification.
      rawBody: true,
      logger: options.nestLogs === false ? false : new ConsoleLogger({ json: true }),
    },
  );
  await configureApp(app, config);
  return app;
}
