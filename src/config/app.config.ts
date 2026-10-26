import {
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateBy,
  validateSync,
} from 'class-validator';
import { isAddressOrRange } from '../common/security/address-list.js';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
const ALLOWLIST_MODES = ['log', 'enforce'] as const;
const APP_ENVS = ['development', 'test', 'production'] as const;

const IsAddressOrRangeEach = () =>
  ValidateBy(
    {
      name: 'isAddressOrRange',
      validator: {
        validate: (value: unknown) => isAddressOrRange(value),
        defaultMessage: () => '$property must contain IP addresses or CIDR ranges',
      },
    },
    { each: true },
  );

// Settings read from the environment and checked once at startup. A bad value
// stops the app from starting (CLAUDE.md section 3). Only DATABASE_URL style
// variables and these; no provider-specific settings.
/** change_log retention (Phase D1). */
export const CHANGE_LOG_RETENTION_DAYS = 30;

export class AppConfig {
  @IsIn(APP_ENVS)
  appEnv!: (typeof APP_ENVS)[number];

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  // Server-side secret mixed into every password, PIN and code hash.
  // Required, at least 32 characters (docs/phase-a-design.md section 7).
  @IsString()
  @MinLength(32)
  authPepper!: string;

  // Signs access, signup and other purpose tokens. Required, at least 32 characters.
  @IsString()
  @MinLength(32)
  jwtSecret!: string;

  // Development only: every code is 123456 for targets on the allowlist.
  // The app refuses to start in production with this on.
  @IsBoolean()
  authDevFixedCodes!: boolean;

  authDevCodeAllowlist!: string[];

  // Per-IP limit on each public auth route, per minute.
  @IsInt()
  @Min(1)
  authRateLimitMax!: number;

  @IsIn(LOG_LEVELS)
  logLevel!: (typeof LOG_LEVELS)[number];

  // Proxies whose X-Forwarded-For is believed. Empty = trust nobody, so
  // request.ip is always the real connection address. In production this is
  // the load balancer's private range (hosting is still an open item).
  @IsAddressOrRangeEach()
  trustProxy!: string[];

  // Where webhook calls may come from, and whether to block or only log
  // others (docs/architecture.md section 8: start in log-only mode).
  @IsAddressOrRangeEach()
  webhookAllowlist!: string[];

  @IsIn(ALLOWLIST_MODES)
  webhookAllowlistMode!: (typeof ALLOWLIST_MODES)[number];

  @IsInt()
  @Min(1)
  rateLimitMax!: number;

  @IsInt()
  @Min(1000)
  rateLimitWindowMs!: number;

  // How long change_log rows are kept for GET /v1/sync/changes, in days
  // (docs/phase-d-design.md section 3). A constant, not an environment
  // setting (decided in D1); the prune passes the cut-off to SQL.
  @IsInt()
  @Min(1)
  changeLogRetentionDays!: number;
}

/** Reads and validates the configuration. Throws, listing the bad settings, if invalid. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = Object.assign(new AppConfig(), {
    appEnv: env.APP_ENV ?? 'development',
    port: toInt(env.PORT, 3000),
    authPepper: env.AUTH_PEPPER,
    jwtSecret: env.JWT_SECRET,
    authDevFixedCodes: toBool(env.AUTH_DEV_FIXED_CODES),
    authDevCodeAllowlist: toList(env.AUTH_DEV_CODE_ALLOWLIST).map((t) => t.toLowerCase()),
    authRateLimitMax: toInt(env.AUTH_RATE_LIMIT_MAX, 10),
    logLevel: env.LOG_LEVEL ?? 'info',
    trustProxy: toList(env.TRUST_PROXY),
    webhookAllowlist: toList(env.WEBHOOK_IP_ALLOWLIST),
    webhookAllowlistMode: env.WEBHOOK_IP_ALLOWLIST_MODE ?? 'log',
    rateLimitMax: toInt(env.RATE_LIMIT_MAX, 100),
    rateLimitWindowMs: toInt(env.RATE_LIMIT_WINDOW_MS, 60_000),
    changeLogRetentionDays: CHANGE_LOG_RETENTION_DAYS,
  });
  const errors = validateSync(config);
  if (errors.length > 0) {
    // Names only: values could be sensitive.
    const names = errors.map((e) => e.property).join(', ');
    throw new Error(`Invalid configuration: ${names}`);
  }
  if (config.appEnv === 'production' && config.authDevFixedCodes) {
    throw new Error('Invalid configuration: authDevFixedCodes must be off in production');
  }
  return config;
}

// "true" and "false" only; anything else fails @IsBoolean.
function toBool(value: string | undefined): boolean | string {
  if (value === undefined || value.trim() === '') return false;
  const v = value.trim().toLowerCase();
  return v === 'true' ? true : v === 'false' ? false : value;
}

// "abc" or "1.5" become NaN, which fails @IsInt (no silent fallback).
function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  return /^-?\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
}

function toList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
