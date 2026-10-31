import { existsSync } from 'node:fs';
import { loadConfig } from './config/app.config.js';
import { createWorker } from './create-worker.js';
import { WorkerModule } from './worker.module.js';

// The background worker (Phase F1, docs/phase-f-design.md section 4): a
// separate process from the API, same codebase. `pnpm start:worker`.
async function bootstrap(): Promise<void> {
  // As main.ts: .env for local development; real environment variables win.
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig();
  const worker = await createWorker(WorkerModule, config);
  // createWorker() registered the job handlers, the sweep schedule and the wake-up listener (F3).
  worker.log.info('worker ready');

  // SIGTERM (a platform stopping the container) and SIGINT (Ctrl+C): stop
  // fetching, let the running job finish, then exit.
  const stop = (signal: string) => {
    worker.log.info({ signal }, 'worker stopping');
    worker.shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}
await bootstrap();
