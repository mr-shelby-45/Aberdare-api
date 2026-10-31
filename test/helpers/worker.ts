import { Test } from '@nestjs/testing';
import { Writable } from 'node:stream';
import { Clock } from '../../src/common/time/clock.js';
import { loadConfig } from '../../src/config/app.config.js';
import { withCore } from '../../src/create-app.js';
import { type CreateWorkerOptions, type Worker, startWorker } from '../../src/create-worker.js';
import { FakePushSender } from '../../src/integrations/push/fake-push.sender.js';
import { PushSender } from '../../src/integrations/push/push.sender.js';
import { WorkerModule } from '../../src/worker.module.js';
import { TEST_ENV } from './app.js';
import type { FakeClock } from './clock.js';

export interface TestWorker extends Worker {
  push: FakePushSender;
  /** The raw text of every log line so far. */
  lines: () => string;
}

/**
 * The worker as production builds it (withCore(WorkerModule) + startWorker),
 * with the given fake clock (share the API test app's, so both agree on
 * "now") and its log lines captured. Phase F3.
 */
export async function startTestWorker(
  clock: FakeClock,
  options: CreateWorkerOptions & { configurePush?: (push: FakePushSender) => void } = {},
): Promise<TestWorker> {
  const queueUrl = process.env.QUEUE_DATABASE_URL;
  if (!queueUrl) throw new Error('TEST_QUEUE_DATABASE_URL is not set (see .env.example)');
  const config = loadConfig({ ...TEST_ENV, QUEUE_DATABASE_URL: queueUrl });
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString('utf8'));
      done();
    },
  });
  const moduleRef = await Test.createTestingModule({ imports: [withCore(WorkerModule, config)] })
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();
  moduleRef.useLogger(false);
  await moduleRef.init();
  // Before the worker fetches anything: jobs left queued by an earlier worker run at once.
  options.configurePush?.(moduleRef.get(PushSender) as FakePushSender);
  const worker = await startWorker(moduleRef, config, { ...options, logStream: sink });
  return Object.assign(worker, { push: moduleRef.get(PushSender) as FakePushSender, lines: () => chunks.join('') });
}
