import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Runs once before all test files: applies every migration to the test
// database as migrator, exactly as a deploy would.
export default function setup(): void {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const url = process.env.TEST_MIGRATION_DATABASE_URL;
  if (!url) throw new Error('TEST_MIGRATION_DATABASE_URL is not set');
  execSync('pnpm exec prisma migrate deploy', {
    env: { ...process.env, MIGRATION_DATABASE_URL: url },
    stdio: 'inherit',
  });
}
