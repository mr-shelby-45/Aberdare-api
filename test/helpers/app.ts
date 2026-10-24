import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Writable } from 'node:stream';
import { loadConfig } from '../../src/config/app.config.js';
import { createApp } from '../../src/create-app.js';
import { SpikeModule } from '../spike/spike.module.js';

export type LogLine = Record<string, unknown> & { msg?: string; requestId?: string };

export interface TestApp {
  app: NestFastifyApplication;
  /** Every log line written so far, parsed. */
  logs: LogLine[];
  /** The raw text of every log line, for "this value never appears" checks. */
  rawLogs: () => string;
}

/**
 * The real app (createApp) with the spike routes, configured from the given
 * environment values, with its log lines captured.
 */
export async function startTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString('utf8'));
      done();
    },
  });
  const config = loadConfig({ RATE_LIMIT_MAX: '1000', ...env });
  const app = await createApp(SpikeModule, config, { logStream: sink, nestLogs: false });
  return {
    app,
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
