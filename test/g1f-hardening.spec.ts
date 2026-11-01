import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { CsvWriter } from '../src/modules/reports/csv-writer.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';
import { type Member, STAFF_PIN, stockApi } from './helpers/stock-api.js';

// Phase G1f: hardening (docs/phase-g1-design.md section 11, G1f tests 1, 3
// and 4). Test 2 (performance) is test/g1f-performance.spec.ts, test 5 (the
// walkthrough) test/g1f-walkthrough.spec.ts. The grants inventory itself is
// test/b5-hardening.spec.ts, unchanged by Phase G1.
//
// Test 1 runs a random workload through the real API, then works out every
// report again in TypeScript from the raw rows (plain SELECTs as the
// superuser: no SUM, no GROUP BY, no time zone conversion in SQL, and its own
// Nairobi day function), and compares.

// Three fixed seeds on every run; G1_SEED=<n> replays one exactly.
const SEEDS = process.env.G1_SEED ? [Number(process.env.G1_SEED)] : [4111, 5222, 6333];
const OPERATIONS = 200;
const RANGE = { from: '2026-10-18', to: '2026-10-25' };
const SUB = { from: '2026-10-20', to: '2026-10-22' };
const DAYS = ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'];
const REASONS = ['DAMAGED', 'EXPIRED', 'LOST', 'FOUND', 'SUPPLIER_RETURN', 'CORRECTION', 'OTHER'] as const;

/** mulberry32: a tiny seeded random generator, so a failing run can be replayed. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)];
  return { next, int, pick };
}

// ---------------------------------------------------------------- the independent arithmetic
/** The Nairobi calendar day of an instant: UTC plus 3 hours (Kenya has no daylight saving). Written here, not imported. */
const nbDay = (d: Date) => new Date(d.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
const inRange = (d: Date, r: { from: string; to: string }) => nbDay(d) >= r.from && nbDay(d) <= r.to;
function money(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}
/** Money cents as NUMERIC(14,2) text; NUMERIC text has exactly two decimals, so string math is exact. */
const toCents = (s: string) => {
  const neg = s.startsWith('-');
  const [w, f] = (neg ? s.slice(1) : s).split('.');
  const v = BigInt(w) * 100n + BigInt((f ?? '').padEnd(2, '0'));
  return neg ? -v : v;
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const byKey = <T extends { key: string }>(xs: T[]) => [...xs].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
function group<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    m.set(k, [...(m.get(k) ?? []), x]);
  }
  return m;
}
const sum = <T>(xs: T[], f: (x: T) => bigint) => xs.reduce((s, x) => s + f(x), 0n);

interface Raw {
  sales: { id: string; sale_number: number; location_id: string; created_by_membership_id: string; occurred_at: Date; status: string; total: string; paid_total: string; balance_due: string; voided_at: Date | null; voided_by_membership_id: string | null; void_reason: string | null; void_approval_id: string | null; void_approved_by_membership_id: string | null }[];
  items: { sale_id: string; line_no: number; pack_type_id: string; product_name: string; pack_type_name: string; quantity: number; unit_price: string; list_price: string; cost_price: string | null; line_total: string }[];
  payments: { id: string; sale_id: string; method: string; amount: string; mpesa_code: string | null; verified: boolean; duplicate_of_payment_id: string | null; status: string; occurred_at: Date; created_by_membership_id: string }[];
  packs: { id: string; product_id: string; name: string; units_per_pack: number; cost_price: string | null }[];
  products: { id: string; name: string; archived_at: Date | null }[];
  locations: { id: string; name: string }[];
  balances: { location_id: string; pack_type_id: string; quantity: number }[];
  movements: { location_id: string; pack_type_id: string; quantity_change: number; movement_type: string; occurred_at: Date; created_by_membership_id: string; reason: string | null; settlement_id: string | null }[];
  settlements: { id: string; attendant_membership_id: string; period_end: Date; expected_cash: string; cash_received: string; cash_variance: string; mpesa_unverified_total: string; unpaid_total: string }[];
  lines: { settlement_id: string; pack_type_id: string; variance: string }[];
}

/** Every row of one business, read as the superuser with plain SELECTs. */
async function readRaw(businessId: string): Promise<Raw> {
  return asAdmin(async (c: pg.Client) => {
    const q = async <T>(sql: string) => (await c.query(sql, [businessId])).rows as T[];
    return {
      sales: await q('SELECT id, sale_number, location_id, created_by_membership_id, occurred_at, status, total, paid_total, balance_due, voided_at, voided_by_membership_id, void_reason, void_approval_id, void_approved_by_membership_id FROM sale WHERE business_id = $1'),
      items: await q('SELECT sale_id, line_no, pack_type_id, product_name, pack_type_name, quantity, unit_price, list_price, cost_price, line_total FROM sale_item WHERE business_id = $1'),
      payments: await q('SELECT id, sale_id, method, amount, mpesa_code, verified, duplicate_of_payment_id, status, occurred_at, created_by_membership_id FROM payment WHERE business_id = $1'),
      packs: await q('SELECT id, product_id, name, units_per_pack, cost_price FROM pack_type WHERE business_id = $1'),
      products: await q('SELECT id, name, archived_at FROM product WHERE business_id = $1'),
      locations: await q('SELECT id, name FROM location WHERE business_id = $1'),
      balances: await q('SELECT location_id, pack_type_id, quantity FROM stock_balance WHERE business_id = $1'),
      movements: await q('SELECT location_id, pack_type_id, quantity_change, movement_type, occurred_at, created_by_membership_id, reason, settlement_id FROM stock_movement WHERE business_id = $1'),
      settlements: await q('SELECT id, attendant_membership_id, period_end, expected_cash, cash_received, cash_variance, mpesa_unverified_total, unpaid_total FROM field_settlement WHERE business_id = $1'),
      lines: await q('SELECT settlement_id, pack_type_id, variance FROM field_settlement_line WHERE business_id = $1'),
    };
  });
}

interface PackSpec {
  id: string;
  productId: string;
  units: number;
  sell: string;
}
interface Biz {
  name: string;
  index: number;
  owner: Member;
  managers: Member[];
  attendants: Member[];
  field: Member[];
  vans: string[];
  shops: string[];
  packs: PackSpec[];
  sales: { id: string; seller: Member; at: string }[];
  codes: string[];
  settlements: number;
  turn: number;
}

describe('G1f: reports hardening', { timeout: 900_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;
  let ip = '';
  let testNo = 0;

  beforeAll(async () => {
    t = await startTestApp();
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await resetTables();
    // Its own IP and phones per test: the auth routes' rate limit counts per IP.
    testNo++;
    ip = `198.51.103.${testNo}`;
    api = stockApi(t, ip, 99_600_000 + testNo * 1000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const get = (url: string, token: string) => t.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` }, remoteAddress: ip });
  async function ok<T>(url: string, token: string): Promise<T> {
    const res = await get(url, token);
    expect(res.statusCode, `${url} ${res.body.slice(0, 300)}`).toBe(200);
    return res.json() as T;
  }
  const nbo = (local: string) => new Date(Date.parse(`${local}+03:00`)).toISOString();
  const plusHours = (local: string, h: number) => new Date(Date.parse(`${local}+03:00`) + h * 3_600_000 + 3 * 3_600_000).toISOString().slice(0, 19);

  async function relogin(...members: Member[]) {
    for (const m of members) {
      const res = await api.post('/v1/auth/pin', { device_id: m.deviceId, device_secret: m.deviceSecret, pin: STAFF_PIN });
      expect(res.statusCode, res.body).toBe(200);
      m.token = api.json<{ access_token: string }>(res).access_token;
    }
  }

  async function business(name: string, index: number): Promise<Biz> {
    const owner = await api.signupOwner(name);
    const managers: Member[] = [];
    for (const n of ['Wanjiru', 'Neema', 'Juma']) {
      const m = await api.activeStaff(owner, 'MANAGER', n);
      expect((await api.call('PATCH', `/v1/staff/${m.membershipId}`, owner.token, { extra_permissions: ['costs.view'] })).statusCode).toBe(204);
      managers.push(m);
    }
    const attendants = [await api.activeStaff(owner, 'ATTENDANT', 'Achieng'), await api.activeStaff(owner, 'ATTENDANT', 'Baraka')];
    const field = [await api.activeStaff(owner, 'FIELD_ATTENDANT', 'Otieno'), await api.activeStaff(owner, 'FIELD_ATTENDANT', 'Kamau')];
    const shops = [api.json<{ locations: { id: string }[] }>(await api.call('GET', '/v1/locations', owner.token)).locations[0].id, await api.newLocation(owner, 'Branch')];
    const vans: string[] = [];
    for (const [i, f] of field.entries()) {
      vans.push(api.json<{ id: string }>(await api.post('/v1/locations', { name: `Van ${i + 1}`, kind: 'FIELD', assigned_membership_id: f.membershipId }, owner.token)).id);
    }
    const packs: PackSpec[] = [];
    const products: [string, [string, number, string, string | null][]][] = [
      ['Soda', [['piece', 1, '50.00', '35.50'], ['crate of 24', 24, '1100.00', '800.00']]],
      ['Chai', [['piece', 1, '33.33', null]]],
      ['Pen', [['piece', 1, '10.00', '6.00'], ['box of 10', 10, '95.00', null]]],
    ];
    for (const [productName, specs] of products) {
      const productId = randomUUID();
      const ids = specs.map(() => randomUUID());
      const r = await api.sendOne(owner.token, api.command('product.create', {
        product_id: productId,
        name: productName,
        pack_types: specs.map(([n, units, sell, cost], i) => ({ pack_type_id: ids[i], name: n, units_per_pack: units, sell_price: sell, ...(cost === null ? {} : { cost_price: cost }) })),
      }));
      expect(r.status, JSON.stringify(r)).toBe('ACCEPTED');
      specs.forEach(([, units, sell], i) => packs.push({ id: ids[i], productId, units, sell }));
    }
    for (const loc of shops) {
      const r = await api.sendOne(managers[0].token, api.command('stock.receive', { location_id: loc, lines: packs.map((p) => ({ pack_type_id: p.id, quantity: p.units === 1 ? 200 : 30 })) }, nbo('2026-10-17T08:00:00')));
      expect(r.status, JSON.stringify(r)).toBe('ACCEPTED');
    }
    for (const van of vans) {
      const r = await api.sendOne(managers[0].token, api.command('stock.issue', { from_location_id: shops[0], to_location_id: van, lines: packs.map((p) => ({ pack_type_id: p.id, quantity: p.units === 1 ? 20 : 3 })) }, nbo('2026-10-17T09:00:00')));
      expect(r.status, JSON.stringify(r)).toBe('ACCEPTED');
    }
    return { name, index, owner, managers, attendants, field, vans, shops, packs, sales: [], codes: [], settlements: 0, turn: 0 };
  }

  /** The workload: one random operation on one business. Rejections are fine; the raw rows decide. */
  async function operate(b: Biz, rng: ReturnType<typeof random>): Promise<void> {
    const at = () => {
      const day = rng.pick(DAYS);
      const r = rng.next();
      if (r < 0.06) return `${day}T23:59:59`;
      if (r < 0.12) return `${day}T00:00:00`;
      return `${day}T${String(rng.int(6, 21)).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}`;
    };
    const send = (m: Member, type: string, payload: object, when?: string) => api.sendOne(m.token, api.command(type, payload, when ? nbo(when) : undefined));
    const code = () => {
      if (b.codes.length > 0 && rng.next() < 0.15) return rng.pick(b.codes);
      const c = `Q${b.index}${String(b.codes.length + 1).padStart(8, '0')}`;
      b.codes.push(c);
      return c;
    };
    const roll = rng.next();
    if (roll < 0.5) {
      // A sale: an attendant or a manager in a shop, or a field attendant from their van.
      const who = rng.next();
      const field = who >= 0.75;
      const fi = rng.int(0, 1);
      const seller = field ? b.field[fi] : who < 0.6 ? rng.pick(b.attendants) : b.managers[0];
      const loc = field ? b.vans[fi] : rng.pick(b.shops);
      const chosen = new Set<PackSpec>();
      const n = rng.int(1, 3);
      while (chosen.size < n) chosen.add(rng.pick(b.packs));
      let total = 0n;
      const lines = [...chosen].map((p) => {
        const list = toCents(p.sell);
        const price = rng.next() < 0.2 ? list - BigInt(rng.int(1, Number(list < 500n ? list - 1n : 500n))) : list;
        const quantity = rng.int(1, 3);
        total += price * BigInt(quantity);
        return { pack_type_id: p.id, quantity, unit_price: money(price) };
      });
      const shape = rng.pick(['cash', 'mpesa', 'split', 'partial', 'unpaid', 'over'] as const);
      const half = total / 2n;
      const payments =
        shape === 'cash' ? [{ method: 'CASH', amount: money(total) }]
          : shape === 'mpesa' ? [{ method: 'MPESA', amount: money(total), mpesa_code: code() }]
            : shape === 'split' ? [{ method: 'CASH', amount: money(half) }, { method: 'MPESA', amount: money(total - half), mpesa_code: code() }]
              : shape === 'partial' ? [{ method: 'CASH', amount: money(half > 0n ? half : 1n) }]
                : shape === 'over' ? [{ method: 'CASH', amount: money(total + 100n) }]
                  : [];
      const id = randomUUID();
      const when = at();
      const r = await send(seller, 'sale.create', { sale_id: id, local_ref: id.slice(0, 8), location_id: loc, lines, payments }, when);
      if (r.status === 'ACCEPTED' || r.status === 'FLAGGED') b.sales.push({ id, seller, at: when });
    } else if (roll < 0.58 && b.sales.length > 0) {
      const s = rng.pick(b.sales);
      const field = b.field.includes(s.seller);
      const payer = field ? s.seller : b.managers[1];
      const amount = money(BigInt(rng.int(5, 50)) * 100n);
      const payment = rng.next() < 0.5 ? { method: 'CASH', amount } : { method: 'MPESA', amount, mpesa_code: code() };
      await send(payer, 'payment.attach', { sale_id: s.id, payments: [payment] }, plusHours(s.at, 2));
    } else if (roll < 0.65 && b.sales.length > 0) {
      const s = rng.pick(b.sales);
      const reason = rng.pick(['MISTAKE', 'CUSTOMER_CANCELLED', 'WRONG_PRICE', 'OTHER'] as const);
      if (b.attendants.includes(s.seller) && rng.next() < 0.3) {
        // An attendant's void, with a manager's approval, at the clock's time.
        const minted = await api.post('/v1/stock/approvals', { approver_membership_id: b.managers[0].membershipId, approver_pin: STAFF_PIN, purpose: 'SALE_VOID' }, s.seller.token);
        expect(minted.statusCode, minted.body).toBe(201);
        await send(s.seller, 'sale.void', { sale_id: s.id, reason, approval_id: api.json<{ approval_id: string }>(minted).approval_id });
      } else {
        await send(b.managers[2], 'sale.void', { sale_id: s.id, reason }, plusHours(s.at, 1));
      }
    } else if (roll < 0.75) {
      const reason = rng.pick(REASONS);
      const size = rng.int(1, 3);
      const change = reason === 'FOUND' ? size : reason === 'CORRECTION' || reason === 'OTHER' ? (rng.next() < 0.5 ? size : -size) : -size;
      await send(rng.pick(b.managers), 'stock.adjust', { location_id: rng.pick(b.shops), pack_type_id: rng.pick(b.packs).id, quantity_change: change, reason }, at());
    } else if (roll < 0.8) {
      const p = rng.pick(b.packs);
      const expected = rng.int(0, 40);
      await send(rng.pick(b.managers), 'stock.count', { location_id: rng.pick(b.shops), lines: [{ pack_type_id: p.id, expected_quantity: expected, counted_quantity: Math.max(0, expected + rng.int(-2, 2)) }] }, at());
    } else if (roll < 0.85) {
      await send(b.managers[0], 'stock.receive', { location_id: rng.pick(b.shops), lines: [{ pack_type_id: rng.pick(b.packs).id, quantity: rng.int(1, 20) }] }, at());
    } else if (roll < 0.9) {
      await send(b.managers[0], 'stock.issue', { from_location_id: b.shops[0], to_location_id: rng.pick(b.vans), lines: [{ pack_type_id: rng.pick(b.packs).id, quantity: rng.int(1, 5) }] }, at());
    } else if (roll < 0.94) {
      await send(b.managers[0], 'stock.return', { from_location_id: rng.pick(b.vans), to_location_id: b.shops[0], lines: [{ pack_type_id: rng.pick(b.packs).id, quantity: 1 }] }, at());
    } else if (b.settlements < 3) {
      // A settlement: the attendant's phone syncs, the manager counts the van and closes.
      const fi = rng.int(0, 1);
      const van = b.vans[fi];
      expect((await api.call('GET', '/v1/sync/snapshot?limit=1', b.field[fi].token)).statusCode).toBe(200);
      const pools = api.json<{ balances: { pack_type_id: string; quantity: number }[] }>(await api.call('GET', `/v1/stock?location_id=${van}&include_zero=true&limit=100`, b.managers[0].token)).balances;
      if (pools.length === 0) return;
      t.clock.advanceMinutes(1);
      const r = await send(b.managers[0], 'settlement.close', {
        settlement_id: randomUUID(),
        field_location_id: van,
        cash_received: money(BigInt(rng.int(0, 500)) * 100n),
        lines: pools.map((p) => ({ pack_type_id: p.pack_type_id, counted_quantity: Math.max(0, p.quantity + rng.int(-2, 1)) })),
      });
      expect(r.status, JSON.stringify(r)).toBe('ACCEPTED');
      b.settlements++;
    }
  }

  /**
   * A fixed opening, so every seed has each rare case at least once: a
   * duplicate M-Pesa code, a below-list line, a void and a supplier return.
   * The random operations follow it.
   */
  async function opening(b: Biz): Promise<void> {
    const send = async (m: Member, type: string, payload: object, when: string) => {
      const r = await api.sendOne(m.token, api.command(type, payload, nbo(when)));
      expect(['ACCEPTED', 'FLAGGED'], `${type} ${JSON.stringify(r)}`).toContain(r.status);
    };
    const [soda] = b.packs;
    const codeOnce = `Q${b.index}DUP00001`;
    b.codes.push(codeOnce);
    for (const [i, when] of ['2026-10-19T10:00:00', '2026-10-20T11:00:00'].entries()) {
      const id = randomUUID();
      const seller = b.attendants[i];
      await send(seller, 'sale.create', { sale_id: id, local_ref: `OPEN${i}`, location_id: b.shops[0], lines: [{ pack_type_id: soda.id, quantity: 1, unit_price: i === 0 ? soda.sell : '45.00' }], payments: [{ method: 'MPESA', amount: i === 0 ? soda.sell : '45.00', mpesa_code: codeOnce }] }, when);
      b.sales.push({ id, seller, at: when });
    }
    await send(b.managers[2], 'sale.void', { sale_id: b.sales[0].id, reason: 'MISTAKE' }, '2026-10-19T12:00:00');
    await send(b.managers[1], 'stock.adjust', { location_id: b.shops[1], pack_type_id: soda.id, quantity_change: -2, reason: 'SUPPLIER_RETURN' }, '2026-10-21T09:00:00');
  }

  /** The next manager, in turn: report routes allow 30 requests a minute per member. */
  const viewer = (b: Biz) => b.managers[b.turn++ % b.managers.length];

  async function allPages(path: string, b: Biz): Promise<{ totals: Record<string, unknown>; rows: Record<string, unknown>[] }> {
    const first = await ok<{ totals: Record<string, unknown>; rows: Record<string, unknown>[]; next_cursor: string | null }>(path, viewer(b).token);
    const rows = [...first.rows];
    let cursor = first.next_cursor;
    while (cursor) {
      const page = await ok<{ totals: Record<string, unknown>; rows: Record<string, unknown>[]; next_cursor: string | null }>(`${path}&cursor=${encodeURIComponent(cursor)}`, viewer(b).token);
      expect(page.totals).toEqual(first.totals);
      rows.push(...page.rows);
      cursor = page.next_cursor;
    }
    return { totals: first.totals, rows };
  }

  /** Every report of one business, compared with the independent answer. */
  async function compare(b: Biz, raw: Raw): Promise<number> {
    let checks = 0;
    const pack = new Map(raw.packs.map((p) => [p.id, p]));
    const product = new Map(raw.products.map((p) => [p.id, p]));
    const sale = new Map(raw.sales.map((s) => [s.id, s]));
    const q = (r: { from: string; to: string }) => `from=${r.from}&to=${r.to}`;
    const completedIn = (r: { from: string; to: string }) => raw.sales.filter((s) => s.status === 'COMPLETED' && inRange(s.occurred_at, r));
    const saleSums = (xs: Raw['sales']) => ({
      sale_count: xs.length,
      total: money(sum(xs, (s) => toCents(s.total))),
      paid_total: money(sum(xs, (s) => toCents(s.paid_total))),
      balance_due: money(sum(xs, (s) => toCents(s.balance_due))),
    });
    const split = (ids: Set<string>) => {
      const ps = raw.payments.filter((p) => p.status === 'RECORDED' && ids.has(p.sale_id));
      return {
        cash: money(sum(ps.filter((p) => p.method === 'CASH'), (p) => toCents(p.amount))),
        mpesa_unverified: money(sum(ps.filter((p) => p.method === 'MPESA' && !p.verified), (p) => toCents(p.amount))),
        mpesa_verified: money(sum(ps.filter((p) => p.method === 'MPESA' && p.verified), (p) => toCents(p.amount))),
      };
    };

    // ---- sales report, every group_by and both filters
    for (const r of [RANGE, SUB]) {
      const xs = completedIn(r);
      for (const groupBy of ['day', 'attendant', 'location'] as const) {
        const rep = await ok<{ totals: unknown; rows: Record<string, unknown>[]; payments: unknown }>(`/v1/reports/sales?${q(r)}&group_by=${groupBy}`, viewer(b).token);
        expect(rep.totals, `sales totals ${groupBy}`).toEqual(saleSums(xs));
        expect(rep.payments, `sales payments ${groupBy}`).toEqual(split(new Set(xs.map((s) => s.id))));
        const keyOf = (s: Raw['sales'][number]) => (groupBy === 'day' ? nbDay(s.occurred_at) : groupBy === 'attendant' ? s.created_by_membership_id : s.location_id);
        const expected = byKey([...group(xs, keyOf)].map(([key, g]) => ({ key, ...saleSums(g) })));
        const actual = byKey(rep.rows.map(({ date, attendant, location, ...f }) => ({ key: (date as string) ?? (attendant as { membership_id: string })?.membership_id ?? (location as { id: string }).id, ...f })));
        expect(actual, `sales rows ${groupBy}`).toEqual(expected);
        checks++;
      }
    }
    const loc = b.shops[1];
    expect((await ok<{ totals: unknown }>(`/v1/reports/sales?${q(RANGE)}&location_id=${loc}`, viewer(b).token)).totals).toEqual(saleSums(completedIn(RANGE).filter((s) => s.location_id === loc)));
    const att = b.attendants[0].membershipId;
    expect((await ok<{ totals: unknown }>(`/v1/reports/sales?${q(RANGE)}&attendant_id=${att}`, viewer(b).token)).totals).toEqual(saleSums(completedIn(RANGE).filter((s) => s.created_by_membership_id === att)));
    // Cross-check: paging GET /v1/sales over the same instants.
    let listed = 0;
    let listedCents = 0n;
    let cursor: string | null = null;
    const start = new Date(Date.parse(`${RANGE.from}T00:00:00+03:00`)).toISOString();
    const end = new Date(Date.parse(`${RANGE.to}T00:00:00+03:00`) + 86_400_000).toISOString();
    do {
      const page: { sales: { total: string }[]; next_cursor: string | null } = await ok(`/v1/sales?status=COMPLETED&from=${start}&to=${end}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, b.managers[0].token);
      listed += page.sales.length;
      listedCents += sum(page.sales, (s) => toCents(s.total));
      cursor = page.next_cursor;
    } while (cursor);
    expect(saleSums(completedIn(RANGE))).toMatchObject({ sale_count: listed, total: money(listedCents) });

    // ---- my day, for both attendants on two days (today is the clock's Nairobi day)
    for (const a of b.attendants) {
      for (const day of ['2026-10-24', '2026-10-19']) {
        const own = raw.sales.filter((s) => s.created_by_membership_id === a.membershipId && nbDay(s.occurred_at) === day);
        const done = own.filter((s) => s.status === 'COMPLETED');
        expect(await ok(`/v1/reports/my-day?date=${day}`, a.token), `my day ${day}`).toEqual({ date: day, ...saleSums(done), voided_count: own.length - done.length, payments: split(new Set(done.map((s) => s.id))) });
        checks++;
      }
    }

    // ---- lines of completed sales in the range: top products and profit
    const linesIn = (r: { from: string; to: string }) => {
      const ids = new Set(completedIn(r).map((s) => s.id));
      return raw.items.filter((i) => ids.has(i.sale_id));
    };
    const profitOf = (ls: Raw['items']) => {
      const costed = ls.filter((l) => l.cost_price !== null);
      const revenue = sum(costed, (l) => toCents(l.line_total));
      const cost = sum(costed, (l) => toCents(l.cost_price!) * BigInt(l.quantity));
      const without = ls.filter((l) => l.cost_price === null);
      return { revenue: money(revenue), cost: money(cost), profit: money(revenue - cost), lines_without_cost: without.length, revenue_without_cost: money(sum(without, (l) => toCents(l.line_total))) };
    };
    const ls = linesIn(RANGE);
    const productOf = (l: Raw['items'][number]) => pack.get(l.pack_type_id)!.product_id;
    for (const by of ['quantity', 'value'] as const) {
      const rep = await ok<{ rows: { product: { id: string; name: string }; pieces: number; value: string; cost: string; profit: string; value_without_cost: string }[] }>(`/v1/reports/top-products?${q(RANGE)}&by=${by}&limit=50`, viewer(b).token);
      const expected = byKey([...group(ls, productOf)].map(([key, g]) => {
        const p = profitOf(g);
        return {
          key,
          name: product.get(key)!.name,
          pieces: Number(sum(g, (l) => BigInt(l.quantity * pack.get(l.pack_type_id)!.units_per_pack))),
          value: money(sum(g, (l) => toCents(l.line_total))),
          cost: p.cost,
          profit: p.profit,
          value_without_cost: p.revenue_without_cost,
        };
      }));
      expect(byKey(rep.rows.map(({ product: pr, ...f }) => ({ key: pr.id, name: pr.name, ...f }))), `top products ${by}`).toEqual(expected);
      // Their order: the measure, highest first, then name, then id.
      const measure = (r: (typeof rep.rows)[number]) => (by === 'quantity' ? BigInt(r.pieces) : toCents(r.value));
      for (let i = 1; i < rep.rows.length; i++) {
        const [x, y] = [rep.rows[i - 1], rep.rows[i]];
        expect(measure(x) > measure(y) || (measure(x) === measure(y) && (x.product.name < y.product.name || (x.product.name === y.product.name && x.product.id < y.product.id)))).toBe(true);
      }
      checks++;
    }
    for (const groupBy of ['day', 'product', 'attendant'] as const) {
      const rep = await ok<{ totals: unknown; lines_without_cost: number; revenue_without_cost: string; rows: Record<string, unknown>[] }>(`/v1/reports/profit?${q(RANGE)}&group_by=${groupBy}`, viewer(b).token);
      const all = profitOf(ls);
      expect(rep.totals, `profit totals ${groupBy}`).toEqual({ revenue: all.revenue, cost: all.cost, profit: all.profit });
      expect([rep.lines_without_cost, rep.revenue_without_cost]).toEqual([all.lines_without_cost, all.revenue_without_cost]);
      const keyOf = (l: Raw['items'][number]) => (groupBy === 'day' ? nbDay(sale.get(l.sale_id)!.occurred_at) : groupBy === 'product' ? productOf(l) : sale.get(l.sale_id)!.created_by_membership_id);
      const expected = byKey([...group(ls, keyOf)].map(([key, g]) => ({ key, ...profitOf(g) })));
      const actual = byKey(rep.rows.map(({ date, product: pr, attendant, ...f }) => ({ key: (date as string) ?? (pr as { id: string })?.id ?? (attendant as { membership_id: string }).membership_id, ...f })));
      expect(actual, `profit rows ${groupBy}`).toEqual(expected);
      for (const row of rep.rows) expect(toCents(row.revenue as string) - toCents(row.cost as string)).toBe(toCents(row.profit as string));
      checks++;
    }

    // ---- stock on hand (GET /v1/stock's defaults: no zero balances, no archived products)
    const pools = raw.balances.filter((x) => x.quantity !== 0 && product.get(pack.get(x.pack_type_id)!.product_id)!.archived_at === null);
    const stockFigures = (g: Raw['balances']) => {
      const positive = g.filter((x) => x.quantity > 0);
      return {
        pieces: g.reduce((s, x) => s + x.quantity * pack.get(x.pack_type_id)!.units_per_pack, 0),
        pools: g.length,
        negative_pools: g.filter((x) => x.quantity < 0).length,
        value_at_cost: money(sum(positive.filter((x) => pack.get(x.pack_type_id)!.cost_price !== null), (x) => toCents(pack.get(x.pack_type_id)!.cost_price!) * BigInt(x.quantity))),
        pools_without_cost: positive.filter((x) => pack.get(x.pack_type_id)!.cost_price === null).length,
      };
    };
    for (const groupBy of ['product', 'location'] as const) {
      const rep = await ok<{ totals: unknown; rows: Record<string, unknown>[] }>(`/v1/reports/stock?group_by=${groupBy}`, viewer(b).token);
      expect(rep.totals, `stock totals ${groupBy}`).toEqual(stockFigures(pools));
      const keyOf = (x: Raw['balances'][number]) => (groupBy === 'product' ? pack.get(x.pack_type_id)!.product_id : x.location_id);
      const expected = byKey([...group(pools, keyOf)].map(([key, g]) => ({ key, ...stockFigures(g) })));
      const actual = byKey(rep.rows.map(({ product: pr, location: lo, packs: _packs, ...f }) => ({ key: (pr as { id: string })?.id ?? (lo as { id: string }).id, ...f })));
      expect(actual, `stock rows ${groupBy}`).toEqual(expected);
      checks++;
    }
    // Cross-check: GET /v1/stock lists the same pools.
    const listedPools = api.json<{ balances: unknown[] }>(await api.call('GET', '/v1/stock?limit=100', b.managers[0].token)).balances;
    expect(listedPools).toHaveLength(pools.length);

    // ---- shrinkage, every group_by
    const shrink = raw.movements.filter(
      (m) => inRange(m.occurred_at, RANGE) && ((m.movement_type === 'ADJUST' && (m.settlement_id !== null || ['DAMAGED', 'EXPIRED', 'LOST', 'FOUND'].includes(m.reason!))) || (m.movement_type === 'COUNT' && m.quantity_change !== 0)),
    );
    const attendantOf = new Map(raw.settlements.map((s) => [s.id, s.attendant_membership_id]));
    const shrinkFigures = (g: Raw['movements']) => {
      const pieces = (m: Raw['movements'][number]) => BigInt(m.quantity_change * pack.get(m.pack_type_id)!.units_per_pack);
      const value = (m: Raw['movements'][number]) => toCents(pack.get(m.pack_type_id)!.cost_price!) * BigInt(m.quantity_change);
      const costed = g.filter((m) => pack.get(m.pack_type_id)!.cost_price !== null);
      return {
        units_lost: Number(-sum(g.filter((m) => m.quantity_change < 0), pieces)),
        units_found: Number(sum(g.filter((m) => m.quantity_change > 0), pieces)),
        net_units: Number(sum(g, pieces)),
        value_lost_at_cost: money(-sum(costed.filter((m) => m.quantity_change < 0), value)),
        value_found_at_cost: money(sum(costed.filter((m) => m.quantity_change > 0), value)),
        net_value_at_cost: money(sum(costed, value)),
        movements_without_cost: g.length - costed.length,
      };
    };
    for (const groupBy of ['reason', 'person', 'location', 'product'] as const) {
      const rep = await ok<{ totals: unknown; rows: Record<string, unknown>[] }>(`/v1/reports/shrinkage?${q(RANGE)}&group_by=${groupBy}`, viewer(b).token);
      expect(rep.totals, `shrinkage totals ${groupBy}`).toEqual(shrinkFigures(shrink));
      const keyOf = (m: Raw['movements'][number]) =>
        groupBy === 'reason' ? (m.settlement_id ? 'SETTLEMENT' : m.movement_type === 'COUNT' ? 'COUNT' : m.reason!)
          : groupBy === 'person' ? (m.settlement_id ? attendantOf.get(m.settlement_id)! : m.created_by_membership_id)
            : groupBy === 'location' ? m.location_id
              : pack.get(m.pack_type_id)!.product_id;
      const expected = byKey([...group(shrink, keyOf)].map(([key, g]) => ({ key, ...shrinkFigures(g) })));
      const actual = byKey(rep.rows.map(({ reason, person, location: lo, product: pr, ...f }) => ({
        key: (reason as string) ?? (person as { membership_id: string })?.membership_id ?? (lo as { id: string })?.id ?? (pr as { id: string }).id,
        ...f,
      })));
      expect(actual, `shrinkage rows ${groupBy}`).toEqual(expected);
      checks++;
    }

    // ---- exceptions, every page
    const voided = raw.sales.filter((s) => s.status === 'VOIDED' && inRange(s.voided_at!, RANGE));
    const voids = await allPages(`/v1/reports/exceptions?type=voids&${q(RANGE)}&limit=7`, b);
    expect(voids.totals).toEqual({ count: voided.length, total: money(sum(voided, (s) => toCents(s.total))) });
    expect(byKey(voids.rows.map((r) => ({ key: r.sale_id as string, n: r.sale_number, total: r.total, reason: r.reason, seller: (r.attendant as { membership_id: string }).membership_id, by: (r.voided_by as { membership_id: string }).membership_id, approver: (r.approved_by as { membership_id: string } | null)?.membership_id ?? null })))).toEqual(
      byKey(voided.map((s) => ({ key: s.id, n: s.sale_number, total: s.total, reason: s.void_reason, seller: s.created_by_membership_id, by: s.voided_by_membership_id, approver: s.void_approval_id ? s.void_approved_by_membership_id : null }))),
    );
    const below = ls.filter((l) => toCents(l.unit_price) < toCents(l.list_price));
    const belowRep = await allPages(`/v1/reports/exceptions?type=below_list&${q(RANGE)}&limit=9`, b);
    const diff = (l: Raw['items'][number]) => (toCents(l.list_price) - toCents(l.unit_price)) * BigInt(l.quantity);
    expect(belowRep.totals).toEqual({ lines: below.length, difference: money(sum(below, diff)) });
    expect(byKey(belowRep.rows.map((r) => ({ key: `${r.sale_id as string}:${r.line_no as number}`, difference: r.difference })))).toEqual(byKey(below.map((l) => ({ key: `${l.sale_id}:${l.line_no}`, difference: money(diff(l)) }))));
    checks += 2;

    // ---- receivables, all time, every page
    const today = nbDay(t.clock.now());
    const unpaid = raw.sales.filter((s) => s.status === 'COMPLETED' && toCents(s.balance_due) > 0n);
    const unpaidRep = await allPages('/v1/reports/receivables?type=unpaid&limit=9', b);
    expect(unpaidRep.totals).toEqual({ count: unpaid.length, balance_due: money(sum(unpaid, (s) => toCents(s.balance_due))) });
    expect(byKey(unpaidRep.rows.map((r) => ({ key: r.sale_id as string, due: r.balance_due, age: r.age_days })))).toEqual(byKey(unpaid.map((s) => ({ key: s.id, due: s.balance_due, age: daysBetween(nbDay(s.occurred_at), today) }))));
    const mpesa = raw.payments.filter((p) => p.method === 'MPESA' && p.status === 'RECORDED' && !p.verified && sale.get(p.sale_id)!.status === 'COMPLETED');
    const mpesaRep = await allPages('/v1/reports/receivables?type=unverified_mpesa&limit=9', b);
    expect(mpesaRep.totals).toEqual({ count: mpesa.length, amount: money(sum(mpesa, (p) => toCents(p.amount))) });
    expect(byKey(mpesaRep.rows.map((r) => ({ key: r.payment_id as string, amount: r.amount, code: r.mpesa_code, duplicate: r.duplicate })))).toEqual(byKey(mpesa.map((p) => ({ key: p.id, amount: p.amount, code: p.mpesa_code, duplicate: p.duplicate_of_payment_id !== null }))));
    checks += 2;

    // ---- the field report
    const closes = raw.settlements.filter((s) => inRange(s.period_end, RANGE));
    const fieldFigures = (g: Raw['settlements']) => {
      const ids = new Set(g.map((s) => s.id));
      const lines = raw.lines.filter((l) => ids.has(l.settlement_id));
      const pieces = (l: Raw['lines'][number]) => BigInt(l.variance) * BigInt(pack.get(l.pack_type_id)!.units_per_pack);
      const short = lines.filter((l) => BigInt(l.variance) < 0n);
      return {
        settlement_count: g.length,
        expected_cash: money(sum(g, (s) => toCents(s.expected_cash))),
        cash_received: money(sum(g, (s) => toCents(s.cash_received))),
        cash_variance: money(sum(g, (s) => toCents(s.cash_variance))),
        mpesa_unverified_total: money(sum(g, (s) => toCents(s.mpesa_unverified_total))),
        unpaid_total: money(sum(g, (s) => toCents(s.unpaid_total))),
        shortage_units: Number(-sum(short, pieces)),
        surplus_units: Number(sum(lines.filter((l) => BigInt(l.variance) > 0n), pieces)),
        shortage_value_at_cost: money(-sum(short.filter((l) => pack.get(l.pack_type_id)!.cost_price !== null), (l) => BigInt(l.variance) * toCents(pack.get(l.pack_type_id)!.cost_price!))),
        shortage_lines_without_cost: short.filter((l) => pack.get(l.pack_type_id)!.cost_price === null).length,
      };
    };
    const fieldRep = await ok<{ totals: unknown; rows: Record<string, unknown>[] }>(`/v1/reports/field?${q(RANGE)}`, viewer(b).token);
    expect(fieldRep.totals).toEqual(fieldFigures(closes));
    expect(byKey(fieldRep.rows.map(({ attendant, ...f }) => ({ key: (attendant as { membership_id: string }).membership_id, ...f })))).toEqual(byKey([...group(closes, (s) => s.attendant_membership_id)].map(([key, g]) => ({ key, ...fieldFigures(g) }))));
    checks++;

    // ---- the CSVs equal their reports
    const salesCsv = (await get(`/v1/reports/sales/export.csv?${q(RANGE)}`, viewer(b).token)).body.slice(1, -2).split('\r\n').slice(1).filter((l) => l.length > 0);
    const done = completedIn(RANGE);
    expect(salesCsv).toHaveLength(done.length);
    expect(new Set(salesCsv.map((l) => Number(l.split(',')[0])))).toEqual(new Set(done.map((s) => s.sale_number)));
    expect(sum(salesCsv, (l) => toCents(l.split(',').at(-3)!))).toBe(sum(done, (s) => toCents(s.total)));
    const stockCsv = (await get('/v1/reports/stock/export.csv', viewer(b).token)).body.slice(1, -2).split('\r\n').slice(1).filter((l) => l.length > 0);
    expect(stockCsv).toHaveLength(pools.length);
    // With costs: quantity is the third column from the end.
    expect(stockCsv.reduce((s, l) => s + Number(l.split(',').at(-3)), 0)).toBe(pools.reduce((s, x) => s + x.quantity, 0));
    checks += 2;
    return checks;
  }

  // ---------------------------------------------------------------- 1. randomized cross-check
  it.each(SEEDS)('1. randomized workload, seed %i: every report equals an independent calculation from the raw rows, and the cross-checks hold', async (seed) => {
    const rng = random(seed);
    const businesses = [await business('Duka Moja', 1), await business('Duka Mbili', 2)];
    for (const b of businesses) await opening(b);
    for (let i = 0; i < OPERATIONS; i++) await operate(businesses[i % 2], rng);
    for (const b of businesses) await relogin(...b.managers, ...b.attendants);
    const summary: string[] = [];
    for (const b of businesses) {
      const raw = await readRaw(b.owner.businessId);
      const checks = await compare(b, raw);
      summary.push(`${b.name}: ${raw.sales.length} sales (${raw.sales.filter((s) => s.status === 'VOIDED').length} voided), ${raw.items.length} lines, ${raw.payments.length} payments, ${raw.movements.length} movements, ${raw.settlements.length} settlements; ${checks} report checks`);
    }
    // The workload must have exercised what it is meant to.
    expect(summary).toHaveLength(2);
    for (const b of businesses) {
      const raw = await readRaw(b.owner.businessId);
      expect(raw.sales.filter((s) => s.status === 'VOIDED').length, `${b.name}: ${summary.join(" | ")}`).toBeGreaterThan(0);
      expect(raw.payments.filter((p) => p.duplicate_of_payment_id !== null).length, `${b.name}: ${summary.join(" | ")}`).toBeGreaterThan(0);
      expect(raw.items.filter((i) => toCents(i.unit_price) < toCents(i.list_price)).length, `${b.name}: ${summary.join(" | ")}`).toBeGreaterThan(0);
      expect(raw.movements.filter((m) => m.reason === 'SUPPLIER_RETURN').length, `${b.name}: ${summary.join(" | ")}`).toBeGreaterThan(0);
      expect(raw.settlements.length, `${b.name}: ${summary.join(" | ")}`).toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------- 3. logs
  it('3. no log line or error_event holds a name, an amount or an M-Pesa code from the data, on success and error paths alike', async () => {
    const MARK = 'ZQXMARK';
    const owner = await api.signupOwner(`${MARK} Duka`);
    const manager = await api.activeStaff(owner, 'MANAGER', `${MARK}Mgr`);
    const seller = await api.activeStaff(owner, 'ATTENDANT', `${MARK}Seller`);
    const attendant = await api.activeStaff(owner, 'ATTENDANT', 'Mwangi');
    const field = await api.activeStaff(owner, 'FIELD_ATTENDANT', `${MARK}Field`);
    const shop = api.json<{ locations: { id: string }[] }>(await api.call('GET', '/v1/locations', owner.token)).locations[0].id;
    const branch = await api.newLocation(owner, `${MARK} Branch`);
    const van = api.json<{ id: string }>(await api.post('/v1/locations', { name: `${MARK} Van`, kind: 'FIELD', assigned_membership_id: field.membershipId }, owner.token)).id;
    const pack = randomUUID();
    const cmd = (m: Member, type: string, payload: object, at?: string) => api.sendOne(m.token, api.command(type, payload, at ? nbo(at) : undefined));
    expect((await cmd(owner, 'product.create', { product_id: randomUUID(), name: `${MARK} Soda`, pack_types: [{ pack_type_id: pack, name: `${MARK} piece`, units_per_pack: 1, sell_price: '4321.87', cost_price: '1234.56' }] })).status).toBe('ACCEPTED');
    for (const l of [shop, branch]) expect((await cmd(manager, 'stock.receive', { location_id: l, lines: [{ pack_type_id: pack, quantity: 50 }] })).status).toBe('ACCEPTED');
    expect((await cmd(manager, 'stock.issue', { from_location_id: shop, to_location_id: van, lines: [{ pack_type_id: pack, quantity: 5 }] })).status).toBe('ACCEPTED');
    expect((await cmd(seller, 'sale.create', { sale_id: randomUUID(), local_ref: 'MK1', location_id: branch, lines: [{ pack_type_id: pack, quantity: 1, unit_price: '4321.87' }], payments: [{ method: 'MPESA', amount: '4321.87', mpesa_code: 'QZX9876543' }] }, '2026-10-21T10:00:00')).status).toBe('ACCEPTED');
    expect(['ACCEPTED', 'FLAGGED']).toContain((await cmd(seller, 'sale.create', { sale_id: randomUUID(), local_ref: 'MK2', location_id: branch, lines: [{ pack_type_id: pack, quantity: 1, unit_price: '4000.01' }] }, '2026-10-21T11:00:00')).status);
    const voidMe = randomUUID();
    expect((await cmd(seller, 'sale.create', { sale_id: voidMe, local_ref: 'MK3', location_id: branch, lines: [{ pack_type_id: pack, quantity: 1, unit_price: '4321.87' }], payments: [{ method: 'CASH', amount: '4321.87' }] }, '2026-10-21T11:30:00')).status).toBe('ACCEPTED');
    expect((await cmd(manager, 'sale.void', { sale_id: voidMe, reason: 'MISTAKE' }, '2026-10-21T11:45:00')).status).toBe('ACCEPTED');
    expect((await cmd(manager, 'stock.adjust', { location_id: branch, pack_type_id: pack, quantity_change: -1, reason: 'DAMAGED', note: `${MARK} note` }, '2026-10-21T12:00:00')).status).toBe('ACCEPTED');
    expect((await api.call('GET', '/v1/sync/snapshot?limit=1', field.token)).statusCode).toBe(200);
    expect((await cmd(manager, 'settlement.close', { settlement_id: randomUUID(), field_location_id: van, cash_received: '4321.87', note: `${MARK} close`, lines: [{ pack_type_id: pack, counted_quantity: 3 }] })).status).toBe('ACCEPTED');
    expect((await api.call('PATCH', `/v1/staff/${manager.membershipId}`, owner.token, { extra_permissions: ['costs.view'] })).statusCode).toBe(204);

    const before = t.rawLogs().length;
    const r = 'from=2026-10-20&to=2026-10-25';
    const urls = [
      `/v1/reports/sales?${r}&group_by=attendant`, `/v1/reports/sales?${r}&group_by=location`, `/v1/reports/top-products?${r}`, `/v1/reports/profit?${r}&group_by=product`,
      '/v1/reports/stock', `/v1/reports/shrinkage?${r}&group_by=person`, `/v1/reports/exceptions?type=below_list&${r}`, `/v1/reports/exceptions?type=voids&${r}`,
      '/v1/reports/receivables?type=unpaid', '/v1/reports/receivables?type=unverified_mpesa', `/v1/reports/field?${r}`, `/v1/reports/sales/export.csv?${r}`, '/v1/reports/stock/export.csv',
    ];
    for (const url of urls) {
      const res = await get(url, manager.token);
      expect(res.statusCode, url).toBe(200);
      // The data is really there, so its absence from the logs means something.
      expect(res.body, url).toMatch(new RegExp(`${MARK}|4321\\.87|QZX9876543|1234\\.56|4000\\.01`));
    }
    expect((await get(`/v1/reports/my-day?date=2026-10-21`, seller.token)).statusCode).toBe(200);
    // Error paths: 403, 422, the range cap, 503 (a held lock) and a forced 500.
    expect((await get(`/v1/reports/sales?${r}`, attendant.token)).statusCode).toBe(403);
    expect((await get('/v1/reports/sales?from=2026-10-22&to=2026-10-21', manager.token)).statusCode).toBe(422);
    expect((await get('/v1/reports/sales?from=2026-07-31&to=2026-10-31', manager.token)).statusCode).toBe(422);
    const holder = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE sale IN ACCESS EXCLUSIVE MODE');
      const release = setTimeout(() => void holder.query('ROLLBACK'), 12_000);
      expect((await get(`/v1/reports/sales?${r}`, owner.token)).statusCode).toBe(503);
      clearTimeout(release);
      await holder.query('ROLLBACK');
    } finally {
      await holder.end();
    }
    vi.spyOn(t.app.get(CsvWriter), 'write').mockImplementationOnce(() => {
      throw new Error(`forced failure`);
    });
    expect((await get(`/v1/reports/sales/export.csv?${r}`, owner.token)).statusCode).toBe(500);

    const logs = t.rawLogs().slice(before);
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [MARK, '4321.87', '1234.56', '4000.01', 'QZX9876543']) expect(logs, secret).not.toContain(secret);
    const events = await asAdmin(async (c) => (await c.query<{ row: string }>('SELECT row_to_json(e)::text AS row FROM error_event e')).rows.map((x) => x.row).join('\n'));
    for (const secret of [MARK, '4321.87', 'QZX9876543']) expect(events, secret).not.toContain(secret);
  }, 120_000);

  // ---------------------------------------------------------------- 4. read only
  it('4. ReportsRepository only reads: no write statement, no Prisma write call, and set_config only for the statement timeout', () => {
    const source = readFileSync(new URL('../src/modules/reports/reports.repository.ts', import.meta.url), 'utf8');
    // Code only: comment lines may describe what the code does not do.
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|COPY|TRUNCATE|ALTER|DROP|CREATE|GRANT|LOCK)\b/i);
    expect(code).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/);
    expect(code.match(/set_config\(/g)).toHaveLength(1);
    expect(code).toContain("set_config('statement_timeout'");
    expect(code.match(/\$executeRaw/g)).toHaveLength(1);
    // Every read goes through the tenant transaction.
    expect(code).not.toMatch(/PrismaService|prisma\./);
    expect((code.match(/currentTx\(\)/g) ?? []).length).toBeGreaterThanOrEqual(12);
  });
});
