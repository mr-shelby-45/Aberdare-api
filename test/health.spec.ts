import { type TestApp, startTestApp } from './helpers/app.js';

describe('GET /health', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  it('returns 200 { status: "ok" }', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
