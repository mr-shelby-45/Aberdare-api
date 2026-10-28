import Fastify, { type FastifyBaseLogger } from 'fastify';
import type { Writable } from 'node:stream';
import { loggerOptions } from './logger.options.js';

/**
 * The worker's logger (Phase F1): the same pino logger, options and
 * redaction as the API's request log, taken from a Fastify instance that never
 * listens (pino reaches the project only through Fastify; no extra library).
 * Every job line carries the job id where the API carries the request id.
 */
export function createWorkerLogger(level: string, stream?: Writable): FastifyBaseLogger {
  return Fastify({ logger: loggerOptions(level, stream) }).log;
}
