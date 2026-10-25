import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config/app.config.js';
import { secretMatches } from '../src/common/security/path-secret.js';
import { TEST_ENV, type TestApp, startTestApp } from './helpers/app.js';
import { TEST_WEBHOOK_SECRET } from './spike/webhook-test.controller.js';

// Spike step 5: Fastify specifics (docs/spike.md). Numbered tests match the
// numbered list in the spike document. Addresses are RFC 5737 documentation
// ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24), never real ones.

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REQUEST_ID = /^req_[A-Za-z0-9_-]{12}$/;

describe('step 5: Fastify specifics', () => {
  let t: TestApp;

  // The very first app start loads Nest, Fastify and the plugins from disk.
  // On a cold machine that took about 20 s once, which would time out
  // whichever test happens to run first. Pay it here instead; every test
  // still starts its own fresh app (about 50 ms).
  beforeAll(async () => {
    const warm = await startTestApp();
    await warm.app.close();
  }, 60_000);

  afterEach(async () => {
    await t?.app.close();
  });

  describe('1. client IP and trustProxy', () => {
    const ipOf = async (remoteAddress: string, forwardedFor?: string) => {
      const res = await t.app.inject({
        method: 'GET',
        url: '/spike/ip',
        remoteAddress,
        headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
      });
      return (res.json() as { ip: string }).ip;
    };

    it('behind a trusted proxy, request.ip is the client from X-Forwarded-For', async () => {
      t = await startTestApp({ TRUST_PROXY: '10.0.0.0/8' });
      expect(await ipOf('10.1.2.3', '203.0.113.9')).toBe('203.0.113.9');
    });

    it('a forged X-Forwarded-For from an untrusted address is ignored', async () => {
      t = await startTestApp({ TRUST_PROXY: '10.0.0.0/8' });
      expect(await ipOf('198.51.100.7', '192.0.2.50')).toBe('198.51.100.7');
    });

    it('a client cannot spoof its IP through the trusted proxy by sending its own header', async () => {
      // The client sends "X-Forwarded-For: 192.0.2.50"; the load balancer appends
      // the real client address. Only the address the proxy saw counts.
      t = await startTestApp({ TRUST_PROXY: '10.0.0.0/8' });
      expect(await ipOf('10.1.2.3', '192.0.2.50, 203.0.113.9')).toBe('203.0.113.9');
    });

    it('with no TRUST_PROXY (the default) every forwarded header is ignored', async () => {
      t = await startTestApp();
      expect(await ipOf('10.1.2.3', '203.0.113.9')).toBe('10.1.2.3');
    });
  });

  it('2. an endpoint gets the exact raw request body bytes', async () => {
    t = await startTestApp();
    // Odd spacing, a newline and non-ASCII: any re-serialising would change it.
    const body = '{ "amount" :  100,\n  "note": "Malipo ya M-Pesa ✓" }';
    const res = await t.app.inject({
      method: 'POST',
      url: '/spike/raw',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    const bytes = Buffer.from(body, 'utf8');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      length: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  });

  describe('3. IP allowlist guard', () => {
    const call = (path: string, remoteAddress: string) =>
      t.app.inject({ method: 'GET', url: path, remoteAddress });

    it('enforce mode: allowed range passes, others get 403', async () => {
      t = await startTestApp();
      expect((await call('/spike/allowlist/enforce', '192.0.2.10')).statusCode).toBe(200);
      const blocked = await call('/spike/allowlist/enforce', '198.51.100.7');
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    });

    it('log mode: everyone passes, and outsiders are logged', async () => {
      t = await startTestApp();
      expect((await call('/spike/allowlist/log', '192.0.2.10')).statusCode).toBe(200);
      const outsider = await call('/spike/allowlist/log', '198.51.100.7');
      expect(outsider.statusCode).toBe(200);
      const warnings = t.logs.filter((l) => l.msg === 'request from outside the IP allowlist');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        sourceIp: '198.51.100.7',
        mode: 'log',
        requestId: outsider.headers['x-request-id'],
      });
    });

    it('IPv4-mapped IPv6 addresses are matched as IPv4', async () => {
      t = await startTestApp();
      expect((await call('/spike/allowlist/enforce', '::ffff:192.0.2.10')).statusCode).toBe(200);
    });
  });

  describe('4. secret in the path', () => {
    it('the right secret works', async () => {
      t = await startTestApp();
      const res = await t.app.inject({ method: 'POST', url: `/webhooks/test/${TEST_WEBHOOK_SECRET}` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true });
    });

    it('a wrong secret looks exactly like a route that does not exist', async () => {
      t = await startTestApp();
      const wrong = await t.app.inject({ method: 'POST', url: '/webhooks/test/not-the-secret' });
      const missing = await t.app.inject({ method: 'POST', url: '/webhooks/nothing-here/at-all' });

      const strip = (body: { error: Record<string, unknown> }) => ({
        ...body.error,
        requestId: undefined,
        timestamp: undefined,
      });
      expect(wrong.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(strip(wrong.json())).toEqual(strip(missing.json()));
      expect(strip(wrong.json())).toEqual({
        code: 'NOT_FOUND',
        message: 'Not found',
        requestId: undefined,
        timestamp: undefined,
      });
      expect(wrong.headers['content-type']).toBe(missing.headers['content-type']);
    });

    it('neither the real nor a wrong secret ever reaches the log', async () => {
      t = await startTestApp();
      await t.app.inject({ method: 'POST', url: `/webhooks/test/${TEST_WEBHOOK_SECRET}` });
      await t.app.inject({ method: 'POST', url: '/webhooks/test/guessed-secret-value' });
      expect(t.rawLogs()).not.toContain(TEST_WEBHOOK_SECRET);
      expect(t.rawLogs()).not.toContain('guessed-secret-value');
      expect(t.logs.filter((l) => l.msg === 'request completed').map((l) => l.route)).toEqual([
        '/webhooks/test/:secret',
        '/webhooks/test/:secret',
      ]);
    });

    it('secretMatches compares in constant time and handles any length', () => {
      expect(secretMatches(TEST_WEBHOOK_SECRET, TEST_WEBHOOK_SECRET)).toBe(true);
      expect(secretMatches('', TEST_WEBHOOK_SECRET)).toBe(false);
      expect(secretMatches(`${TEST_WEBHOOK_SECRET}x`, TEST_WEBHOOK_SECRET)).toBe(false);
      expect(secretMatches('x'.repeat(10_000), TEST_WEBHOOK_SECRET)).toBe(false);
    });
  });

  describe('5. validation and error shape', () => {
    it('an invalid body returns 422 with the standard error shape', async () => {
      t = await startTestApp();
      const res = await t.app.inject({
        method: 'POST',
        url: '/spike/validate',
        payload: { name: '', quantity: 'two' },
      });
      expect(res.statusCode).toBe(422);
      const { error } = res.json() as { error: Record<string, string> };
      expect(Object.keys(error).sort()).toEqual(['code', 'message', 'requestId', 'timestamp']);
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.message).toBe('Invalid fields: name, quantity');
      expect(error.requestId).toMatch(REQUEST_ID);
      expect(error.requestId).toBe(res.headers['x-request-id']);
      expect(error.timestamp).toMatch(ISO_UTC);
    });

    it('unknown fields are rejected too (422)', async () => {
      t = await startTestApp();
      const res = await t.app.inject({
        method: 'POST',
        url: '/spike/validate',
        payload: { name: 'Sugar', quantity: 1, businessId: '00000000-0000-4000-8000-000000000000' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    });

    it('a body that is not JSON returns 400 in the same shape', async () => {
      t = await startTestApp();
      const res = await t.app.inject({
        method: 'POST',
        url: '/spike/validate',
        headers: { 'content-type': 'application/json' },
        payload: '{"name": "Sugar",',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'BAD_REQUEST', requestId: res.headers['x-request-id'] } });
    });

    it('an unexpected error returns INTERNAL_ERROR with no stack trace or internals', async () => {
      t = await startTestApp();
      const res = await t.app.inject({ method: 'GET', url: '/spike/boom' });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Something went wrong',
          requestId: res.headers['x-request-id'],
          timestamp: expect.stringMatching(ISO_UTC),
        },
      });
      for (const leak of ['stack', 'at ', '4321', '/internal/secret/path', 'insert failed']) {
        expect(res.body, leak).not.toContain(leak);
      }
      // It is logged for support, by request ID, without the message's values.
      const errorLine = t.logs.find((l) => l.msg === 'unhandled error');
      expect(errorLine).toMatchObject({ requestId: res.headers['x-request-id'] });
      expect(JSON.stringify(errorLine)).not.toContain('4321');
    });
  });

  describe('6. logging', () => {
    it('one structured JSON line per request, with time, requestId, route, status and duration', async () => {
      t = await startTestApp();
      const res = await t.app.inject({ method: 'GET', url: '/health' });
      const lines = t.logs.filter((l) => l.requestId === res.headers['x-request-id']);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        msg: 'request completed',
        method: 'GET',
        route: '/health',
        status: 200,
        requestId: expect.stringMatching(REQUEST_ID),
        time: expect.stringMatching(ISO_UTC),
        durationMs: expect.any(Number),
      });
    });

    it('request IDs are generated by the server, never taken from the client', async () => {
      t = await startTestApp();
      const res = await t.app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-request-id': 'attacker-chosen', 'request-id': 'attacker-chosen' },
      });
      expect(res.headers['x-request-id']).toMatch(REQUEST_ID);
      expect(t.rawLogs()).not.toContain('attacker-chosen');
    });

    it('pin and otp values never appear in any log line, even when a handler logs the whole body', async () => {
      t = await startTestApp();
      const ok = await t.app.inject({
        method: 'POST',
        url: '/spike/login',
        payload: { phone: '+254712345678', pin: '4321', otp: '908172' },
      });
      expect(ok.statusCode).toBe(201);
      // Also on the validation-failure path (bad phone) and the error path.
      await t.app.inject({
        method: 'POST',
        url: '/spike/login',
        payload: { phone: 'nope', pin: '4321', otp: '908172' },
      });
      await t.app.inject({ method: 'GET', url: '/spike/boom' });

      const raw = t.rawLogs();
      expect(raw).not.toContain('4321');
      expect(raw).not.toContain('908172');
      expect(raw).not.toContain('+254712345678');
      const careless = t.logs.find((l) => l.msg === 'login attempt');
      expect(careless).toMatchObject({
        body: { pin: '[REDACTED]', otp: '[REDACTED]', phone: '**********678' },
      });
    });
  });

  describe('7. security headers and rate limit', () => {
    it('@fastify/helmet sets security headers on responses', async () => {
      t = await startTestApp();
      const res = await t.app.inject({ method: 'GET', url: '/health' });
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    });

    it('@fastify/rate-limit answers a burst with 429 in the standard error shape', async () => {
      t = await startTestApp({ RATE_LIMIT_MAX: '5', RATE_LIMIT_WINDOW_MS: '60000' });
      const statuses: number[] = [];
      let last;
      for (let i = 0; i < 7; i++) {
        last = await t.app.inject({ method: 'GET', url: '/health', remoteAddress: '198.51.100.7' });
        statuses.push(last.statusCode);
      }
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
      expect(last!.json()).toEqual({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Try again later.',
          requestId: last!.headers['x-request-id'],
          timestamp: expect.stringMatching(ISO_UTC),
        },
      });
      expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
      // Another client is not affected by the first one's burst.
      const other = await t.app.inject({ method: 'GET', url: '/health', remoteAddress: '192.0.2.10' });
      expect(other.statusCode).toBe(200);
    });
  });

  describe('configuration is checked at startup', () => {
    it('defaults are valid and trust no proxy', () => {
      // Only the two required secrets (Phase A2) are given.
      expect(loadConfig({ AUTH_PEPPER: TEST_ENV.AUTH_PEPPER, JWT_SECRET: TEST_ENV.JWT_SECRET })).toMatchObject({
        appEnv: 'development',
        port: 3000,
        trustProxy: [],
        webhookAllowlist: [],
        webhookAllowlistMode: 'log',
        authDevFixedCodes: false,
        authRateLimitMax: 10,
      });
    });

    it('bad values stop the app from starting, naming the settings', () => {
      expect(() =>
        loadConfig({
          AUTH_PEPPER: TEST_ENV.AUTH_PEPPER,
          JWT_SECRET: TEST_ENV.JWT_SECRET,
          PORT: 'abc',
          TRUST_PROXY: '10.0.0.0/8, not-an-address',
          WEBHOOK_IP_ALLOWLIST: '192.0.2.0/99',
          WEBHOOK_IP_ALLOWLIST_MODE: 'block',
          RATE_LIMIT_MAX: '1.5',
        }),
      ).toThrow(
        'Invalid configuration: port, trustProxy, webhookAllowlist, webhookAllowlistMode, rateLimitMax',
      );
    });
  });
});
