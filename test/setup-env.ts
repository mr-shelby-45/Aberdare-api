import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

// Tests always use the separate test database, never the development one.
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  throw new Error('TEST_DATABASE_URL is not set (see .env.example)');
}
process.env.DATABASE_URL = testUrl;
// The worker's queue connection (Phase F1): the test database too, never the
// development one. Unset when TEST_QUEUE_DATABASE_URL is missing, so a worker
// test fails with a clear message instead of reaching aberdare.
if (process.env.TEST_QUEUE_DATABASE_URL) process.env.QUEUE_DATABASE_URL = process.env.TEST_QUEUE_DATABASE_URL;
else delete process.env.QUEUE_DATABASE_URL;
