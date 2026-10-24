import {
  IsIn,
  IsInt,
  Max,
  Min,
  ValidateBy,
  validateSync,
} from 'class-validator';
import { isAddressOrRange } from '../common/security/address-list.js';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
const ALLOWLIST_MODES = ['log', 'enforce'] as const;

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
export class AppConfig {
  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

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
}

/** Reads and validates the configuration. Throws, listing the bad settings, if invalid. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = Object.assign(new AppConfig(), {
    port: toInt(env.PORT, 3000),
    logLevel: env.LOG_LEVEL ?? 'info',
    trustProxy: toList(env.TRUST_PROXY),
    webhookAllowlist: toList(env.WEBHOOK_IP_ALLOWLIST),
    webhookAllowlistMode: env.WEBHOOK_IP_ALLOWLIST_MODE ?? 'log',
    rateLimitMax: toInt(env.RATE_LIMIT_MAX, 100),
    rateLimitWindowMs: toInt(env.RATE_LIMIT_WINDOW_MS, 60_000),
  });
  const errors = validateSync(config);
  if (errors.length > 0) {
    // Names only: values could be sensitive.
    const names = errors.map((e) => e.property).join(', ');
    throw new Error(`Invalid configuration: ${names}`);
  }
  return config;
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
