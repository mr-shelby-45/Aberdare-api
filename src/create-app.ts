import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import {
  ConsoleLogger,
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
import { ApiError } from './common/errors/api.error.js';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter.js';
import { loggerOptions } from './common/logging/logger.options.js';
import { RequestLogController } from './common/logging/request-log.controller.js';
import type { AppConfig } from './config/app.config.js';

export interface CreateAppOptions {
  // Where request log lines go (tests capture them). Default: stdout.
  logStream?: Writable;
  // Nest's own startup lines. Tests turn them off to keep output readable.
  nestLogs?: boolean;
}

/**
 * Builds the HTTP app exactly as production runs it: Fastify with proxy
 * trust, server-generated request IDs, one JSON log line per request, the
 * error shape filter, validation, helmet, rate limiting and raw bodies.
 * Used by main.ts and by the tests, so tests exercise the real setup.
 */
export async function createApp(
  rootModule: Type<unknown>,
  config: AppConfig,
  options: CreateAppOptions = {},
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    // Empty list = trust no proxy: request.ip is the socket address.
    trustProxy: config.trustProxy.length > 0 ? config.trustProxy : false,
    // Never taken from an incoming header.
    requestIdHeader: false,
    genReqId: () => `req_${randomBytes(9).toString('base64url')}`,
    logger: loggerOptions(config.logLevel, options.logStream),
    logController: new RequestLogController(),
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    rootModule,
    adapter,
    {
      // Exact request bytes on req.rawBody, for webhook verification.
      rawBody: true,
      logger: options.nestLogs === false ? false : new ConsoleLogger({ json: true }),
    },
  );

  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  await app.register(helmet);
  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    // Becomes a 429 that AllExceptionsFilter turns into the standard shape.
    errorResponseBuilder: () => ({ statusCode: 429, message: 'Too many requests' }),
  });

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
  return app;
}
