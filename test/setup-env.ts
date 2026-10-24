import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

// Tests always use the separate test database, never the development one.
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  throw new Error('TEST_DATABASE_URL is not set (see .env.example)');
}
process.env.DATABASE_URL = testUrl;
