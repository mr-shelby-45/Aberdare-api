import { ConsoleLogger, type INestApplicationContext, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { FastifyBaseLogger } from 'fastify';
import type { Writable } from 'node:stream';
import { createWorkerLogger } from './common/logging/worker-logger.js';
import type { AppConfig } from './config/app.config.js';
import { withCore } from './create-app.js';
import { JobQueue } from './jobs/job-queue.service.js';

export interface CreateWorkerOptions {
  // Where log lines go (tests capture them). Default: stdout.
  logStream?: Writable;
  // Nest's own startup lines. Tests turn them off.
  nestLogs?: boolean;
}

export interface Worker {
  app: INestApplicationContext;
  queue: JobQueue;
  log: FastifyBaseLogger;
  /** Stops fetching jobs, waits for running ones (up to the timeout), closes everything. Safe to call twice. */
  shutdown(): Promise<void>;
}

/**
 * Builds and starts the worker exactly as production runs it (Phase F1,
 * docs/phase-f-design.md section 4): the Nest application context (no HTTP
 * server) with CoreModule, then pg-boss. Used by worker.ts; tests build the
 * same worker with this function.
 */
export async function createWorker(rootModule: Type<unknown>, config: AppConfig, options: CreateWorkerOptions = {}): Promise<Worker> {
  if (!config.queueDatabaseUrl) throw new Error('Invalid configuration: queueDatabaseUrl (QUEUE_DATABASE_URL) is required by the worker');
  const log = createWorkerLogger(config.logLevel, options.logStream);
  const app = await NestFactory.createApplicationContext(withCore(rootModule, config), {
    logger: options.nestLogs === false ? false : new ConsoleLogger({ json: true }),
  });
  const queue = app.get(JobQueue);
  await queue.start(log);
  let closing: Promise<void> | null = null;
  return {
    app,
    queue,
    log,
    shutdown() {
      closing ??= (async () => {
        await queue.stop();
        await app.close();
        log.info('worker stopped');
      })();
      return closing;
    },
  };
}
