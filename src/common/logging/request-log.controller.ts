import { type FastifyReply, type FastifyRequest, LogController } from 'fastify';

// Replaces Fastify's default request logging (two lines per request, with the
// full URL) by exactly one structured line when the response is sent:
//   { time, requestId, method, route, status, durationMs }
// `route` is the route pattern ("/webhooks/test/:secret"), never the real URL,
// so secrets in paths never reach the log.
export class RequestLogController extends LogController {
  constructor() {
    super({ requestIdLogLabel: 'requestId' });
  }

  override incomingRequest(): void {}

  override routeNotFound(): void {}

  override requestCompleted(
    _error: Error | null | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url ?? null,
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
  }
}
