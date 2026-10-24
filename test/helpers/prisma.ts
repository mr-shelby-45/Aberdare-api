import { PrismaService } from '../../src/database/prisma.service.js';

/**
 * A PrismaService with a fixed pool size (and optionally a longer wait for a
 * free connection), connected as app_user.
 */
export function prismaWithPool(
  max: number,
  options: { txMaxWaitMs?: number } = {},
): PrismaService {
  const overrides: Record<string, string | undefined> = {
    DATABASE_POOL_MAX: String(max),
    DATABASE_TX_MAX_WAIT_MS:
      options.txMaxWaitMs === undefined ? undefined : String(options.txMaxWaitMs),
  };
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return new PrismaService();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
