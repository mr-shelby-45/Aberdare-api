import { Injectable } from '@nestjs/common';
import type { FastifyBaseLogger } from 'fastify';
import { PgBoss, type QueuePolicy } from 'pg-boss';
import { AppConfig } from '../config/app.config.js';
import { errorCodeForLog } from '../database/db-errors.js';
import { QUEUE_SCHEMA } from './queue-schema.js';

/** A job handler: the job's data and its id. Throwing fails the job (pg-boss retries it by its queue policy). */
export type JobHandler<T extends object> = (data: T, jobId: string) => Promise<void>;

// The job queue (Phase F1, docs/phase-f-design.md section 4): pg-boss inside
// Postgres. It connects as queue_user (QUEUE_DATABASE_URL), which can reach
// only the pgboss schema; handlers touch business data only through
// TenantRunner as app_user, one business per transaction. The schema must be
// up to date (`pnpm queue:migrate`): start() refuses otherwise. Queues are
// never partitioned, so nothing runs DDL at runtime.
@Injectable()
export class JobQueue {
  private boss: PgBoss | null = null;
  private log: FastifyBaseLogger | null = null;

  constructor(private readonly config: AppConfig) {}

  async start(log: FastifyBaseLogger): Promise<void> {
    if (this.boss) throw new Error('JobQueue already started');
    const connectionString = this.config.queueDatabaseUrl;
    if (!connectionString) throw new Error('QUEUE_DATABASE_URL is not set (the worker needs it)');
    const boss = new PgBoss({ connectionString, schema: QUEUE_SCHEMA, createSchema: false, migrate: false, max: 5 });
    // pg-boss emits background errors (maintenance, polling); unhandled they would crash the process.
    boss.on('error', (err: unknown) => {
      log.error({ errorName: err instanceof Error ? err.name : 'Error', errorCode: errorCodeForLog(err) }, 'job queue error');
    });
    await boss.start();
    this.boss = boss;
    this.log = log;
  }

  /** Creates the queue if it does not exist (idempotent), with its policy and job expiry. Never partitioned. */
  async ensureQueue(name: string, options: { policy?: QueuePolicy; expireInSeconds?: number } = {}): Promise<void> {
    await this.started().createQueue(name, options);
  }

  /**
   * Adds a job; returns its id, or null when the queue policy refused it (for
   * example a stately queue that already has one job queued for singletonKey).
   */
  async send(name: string, data: object, options: { singletonKey?: string } = {}): Promise<string | null> {
    return this.started().send(name, data, options);
  }

  /** A cron schedule (UTC), stored by pg-boss in the database: one schedule per name, however many workers run. */
  async schedule(name: string, cron: string): Promise<void> {
    await this.started().schedule(name, cron, {}, { tz: 'UTC' });
  }

  /** Handles jobs of this queue (one at a time, or localConcurrency at once), logging job, id, duration and outcome (never the data). */
  async work<T extends object>(name: string, handler: JobHandler<T>, options: { localConcurrency?: number } = {}): Promise<void> {
    const boss = this.started();
    const log = this.log!;
    await boss.createQueue(name);
    await boss.work<T>(name, { batchSize: 1, ...options }, async ([job]) => {
      const startedAt = performance.now();
      try {
        await handler(job.data, job.id);
        log.info({ job: name, jobId: job.id, ms: Math.round(performance.now() - startedAt), outcome: 'ok' }, 'job done');
      } catch (err) {
        log.error(
          {
            job: name,
            jobId: job.id,
            ms: Math.round(performance.now() - startedAt),
            outcome: 'failed',
            errorName: err instanceof Error ? err.name : 'Error',
            errorCode: errorCodeForLog(err),
          },
          'job failed',
        );
        throw err;
      }
    });
  }

  /** Stops fetching, lets running jobs finish (up to the shutdown timeout), then closes the pool. */
  async stop(): Promise<void> {
    const boss = this.boss;
    if (!boss) return;
    this.boss = null;
    await boss.stop({ graceful: true, close: true, timeout: this.config.workerShutdownTimeoutMs });
  }

  private started(): PgBoss {
    if (!this.boss) throw new Error('JobQueue not started');
    return this.boss;
  }
}
