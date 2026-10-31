import type { Writable } from 'node:stream';

// Field names whose values must never appear in a log (CLAUDE.md rule 12).
// Request bodies are never logged on purpose; this is the backstop for a
// mistake such as logging a whole object.
const SECRET_FIELDS = [
  'pin',
  'otp',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'shopKey',
  'secret',
  'authorization',
  // Phase A credentials, in the field names the auth routes use.
  'code',
  'phone_code',
  'email_code',
  'temp_pin',
  'new_pin',
  'new_password',
  'signup_token',
  'setup_token',
  'selection_token',
  'access_token',
  'refresh_token',
  'device_secret',
  // Phase F3: a phone's push token.
  'push_token',
  'pushToken',
];
const PHONE_FIELDS = ['phone', 'phoneNumber', 'msisdn'];

// pino matches one level per "*", so cover the field at the top and two
// levels down ({ body: { customer: { phone } } }).
const paths = [...SECRET_FIELDS, ...PHONE_FIELDS].flatMap((field) => [
  field,
  `*.${field}`,
  `*.*.${field}`,
]);

function censor(value: unknown, path: string[]): string {
  const field = path[path.length - 1];
  if (PHONE_FIELDS.includes(field) && typeof value === 'string' && value.length > 3) {
    // Mask all but the last 3 digits.
    return `${'*'.repeat(value.length - 3)}${value.slice(-3)}`;
  }
  return '[REDACTED]';
}

/** Options for Fastify's built-in logger (pino): JSON lines with an ISO UTC time. */
export function loggerOptions(level: string, stream?: Writable) {
  return {
    level,
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    redact: { paths, censor },
    ...(stream ? { stream } : {}),
  };
}
