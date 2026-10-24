import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './api.error.js';

const CODES: Record<number, { code: string; message: string }> = {
  400: { code: 'BAD_REQUEST', message: 'The request could not be read' },
  401: { code: 'UNAUTHORIZED', message: 'Not signed in' },
  403: { code: 'FORBIDDEN', message: 'Not allowed' },
  404: { code: 'NOT_FOUND', message: 'Not found' },
  405: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'The request is too large' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported content type' },
  422: { code: 'VALIDATION_FAILED', message: 'The request is not valid' },
  429: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' },
};
const INTERNAL = { code: 'INTERNAL_ERROR', message: 'Something went wrong' };

// The one error response shape for every endpoint, including Fastify's own
// errors (unknown route, bad JSON, rate limit):
//   { "error": { code, message, requestId, timestamp } }
// Internal details, SQL and stack traces never reach the response.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const { status, code, message } = describe(exception);
    if (status >= 500) {
      // TODO(verify with Ian): report to Sentry once its SDK is approved.
      request.log.error({ error: safeSummary(exception) }, 'unhandled error');
    }
    void reply.status(status).send({
      error: {
        code,
        message,
        requestId: request.id,
        timestamp: new Date().toISOString(),
      },
    });
  }
}

function describe(exception: unknown): { status: number; code: string; message: string } {
  if (exception instanceof ApiError) {
    return { status: exception.getStatus(), code: exception.code, message: exception.message };
  }
  // Nest's own HttpExceptions and Fastify/plugin errors that carry a 4xx
  // statusCode. Their messages can contain paths or internals ("Cannot GET
  // /webhooks/..."), so the message is always the generic one.
  const status =
    exception instanceof HttpException ? exception.getStatus() : clientStatus(exception);
  if (status !== undefined && status >= 400 && status < 500) {
    const known = CODES[status] ?? { code: 'REQUEST_FAILED', message: 'The request failed' };
    return { status, ...known };
  }
  return { status: 500, ...INTERNAL };
}

function clientStatus(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const value = (exception as { statusCode?: unknown }).statusCode;
  return typeof value === 'number' ? value : undefined;
}

// For the log only. The message is left out on purpose: error messages (from
// Prisma, for example) can contain the values that were being written, such
// as a phone number or a PIN (CLAUDE.md rule 12). Name, code and stack frames
// are enough to find the failing line.
function safeSummary(exception: unknown): Record<string, unknown> {
  if (!(exception instanceof Error)) return { type: typeof exception };
  const code = (exception as { code?: unknown }).code;
  return {
    name: exception.name,
    code: typeof code === 'string' ? code : undefined,
    frames: (exception.stack ?? '').split('\n').slice(1, 11).map((line) => line.trim()),
  };
}
