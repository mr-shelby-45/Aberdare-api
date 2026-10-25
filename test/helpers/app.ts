import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Writable } from 'node:stream';
import { PasswordHasher } from '../../src/common/auth/password-hasher.js';
import { Clock } from '../../src/common/time/clock.js';
import { loadConfig } from '../../src/config/app.config.js';
import { configureApp, createAdapter, withCore } from '../../src/create-app.js';
import { SpikeModule } from '../spike/spike.module.js';
import { FakeClock } from './clock.js';
import { FastPasswordHasher } from './fast-password-hasher.js';

export type LogLine = Record<string, unknown> & { msg?: string; requestId?: string };

// Fixed test secrets (at least 32 characters, as the config requires).
export const TEST_ENV: Record<string, string> = {
  AUTH_PEPPER: 'test-pepper-0123456789abcdefghijklmnopqrstuv',
  JWT_SECRET: 'test-jwt-secret-0123456789abcdefghijklmnopq',
  APP_ENV: 'test',
  RATE_LIMIT_MAX: '1000',
  AUTH_RATE_LIMIT_MAX: '1000',
};

export interface TestApp {
  app: NestFastifyApplication;
  clock: FakeClock;
  /** Every log line written so far, parsed. */
  logs: LogLine[];
  /** The raw text of every log line, for "this value never appears" checks. */
  rawLogs: () => string;
}

/**
 * The real app, built from the same pieces as createApp() (withCore,
 * createAdapter, configureApp) plus the spike routes, with a fake clock and
 * its log lines captured. env values override TEST_ENV.
 */
export async function startTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString('utf8'));
      done();
    },
  });
  const config = loadConfig({ ...TEST_ENV, ...env });
  const clock = new FakeClock();
  // Test app only (approved by Ian in B5, as in spike step 1 test 5): wait up
  // to 10 s for a pooled connection instead of Prisma's 2 s. Concurrency tests
  // fire 20 requests at a pool of 10, and on this busy dev machine the 2 s wait
  // ran out once (spike open risk 4). Production keeps 2000. PrismaService
  // reads the setting when it is built, so it is set only around compile().
  const previousWait = process.env.DATABASE_TX_MAX_WAIT_MS;
  process.env.DATABASE_TX_MAX_WAIT_MS = env.DATABASE_TX_MAX_WAIT_MS ?? '10000';
  let moduleRef;
  try {
    moduleRef = await Test.createTestingModule({ imports: [withCore(SpikeModule, config)] })
      .overrideProvider(Clock)
      .useValue(clock)
      // Test-only scrypt cost (see fast-password-hasher.ts); the production
      // cost is checked in test/password-hasher.spec.ts.
      .overrideProvider(PasswordHasher)
      .useValue(new FastPasswordHasher(config))
      .compile();
  } finally {
    if (previousWait === undefined) delete process.env.DATABASE_TX_MAX_WAIT_MS;
    else process.env.DATABASE_TX_MAX_WAIT_MS = previousWait;
  }
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    createAdapter(config, { logStream: sink }),
    { rawBody: true, logger: false },
  );
  await configureApp(app, config);
  return {
    app,
    clock,
    get logs() {
      return chunks
        .join('')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as LogLine);
    },
    rawLogs: () => chunks.join(''),
  };
}
