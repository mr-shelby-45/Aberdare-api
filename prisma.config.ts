import { existsSync } from 'node:fs';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 does not read .env itself. Node's built-in loader does it without dotenv.
// Real environment variables (CI, servers) win over values in .env.
if (existsSync('.env')) process.loadEnvFile('.env');

// The Prisma CLI is only used for migrations, so it always connects as migrator.
// The running app connects as app_user through DATABASE_URL (see PrismaService).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('MIGRATION_DATABASE_URL'),
    shadowDatabaseUrl: env('SHADOW_DATABASE_URL'),
  },
});
