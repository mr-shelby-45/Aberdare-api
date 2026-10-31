import { ConsoleLogger, type INestApplicationContext, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { FastifyBaseLogger } from 'fastify';
import type { Writable } from 'node:stream';
import { createWorkerLogger } from './common/logging/worker-logger.js';
import type { AppConfig } from './config/app.config.js';
import { withCore } from './create-app.js';
import { JobQueue } from './jobs/job-queue.service.js';
import { NotificationJobs, type NotificationJobsOptions } from './jobs/notification-jobs.service.js';
import { ScheduledJobs } from './jobs/scheduled-jobs.service.js';

export interface CreateWorkerOptions extends NotificationJobsOptions {
  // Where log lines go (tests capture them). Default: stdout.
  logStream?: Writable;
  // Nest's own startup lines. Tests turn them off.
  nestLogs?: boolean;
}

export interface Worker {
  app: INestApplicationContext;
  queue: JobQueue;
  jobs: NotificationJobs;
  scheduled: ScheduledJobs;
  log: FastifyBaseLogger;
  /** Stops listening and fetching jobs, waits for running ones (up to the timeout), closes everything. Safe to call twice. */
  shutdown(): Promise<void>;
}

/**
 * Builds and starts the worker exactly as production runs it (Phase F1,
 * docs/phase-f-design.md section 4): the Nest application context (no HTTP
 * server) with CoreModule, then startWorker(). Used by worker.ts.
 */
export async function createWorker(rootModule: Type<unknown>, config: AppConfig, options: CreateWorkerOptions = {}): Promise<Worker> {
  if (!config.queueDatabaseUrl) throw new Error('Invalid configuration: queueDatabaseUrl (QUEUE_DATABASE_URL) is required by the worker');
  const app = await NestFactory.createApplicationContext(withCore(rootModule, config), {
    logger: options.nestLogs === false ? false : new ConsoleLogger({ json: true }),
  });
  return startWorker(app, config, options);
}

/**
 * Starts pg-boss and registers the job handlers on an application context
 * built from withCore(WorkerModule). Tests build that context with a fake
 * clock (test/helpers/worker.ts) and start it with this same function.
 */
export async function startWorker(app: INestApplicationContext, config: AppConfig, options: CreateWorkerOptions = {}): Promise<Worker> {
  if (!config.queueDatabaseUrl) throw new Error('Invalid configuration: queueDatabaseUrl (QUEUE_DATABASE_URL) is required by the worker');
  const log = createWorkerLogger(config.logLevel, options.logStream);
  const queue = app.get(JobQueue);
  const jobs = app.get(NotificationJobs);
  const scheduled = app.get(ScheduledJobs);
  await queue.start(log);
  await jobs.register(queue, log, options);
  await scheduled.register(queue, log, options);
  let closing: Promise<void> | null = null;
  return {
    app,
    queue,
    jobs,
    scheduled,
    log,
    shutdown() {
      closing ??= (async () => {
        await jobs.stop();
        await queue.stop();
        await app.close();
        log.info('worker stopped');
      })();
      return closing;
    },
  };
}
