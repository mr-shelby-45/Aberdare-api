import type { LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { SYNC_TABLE_NAMES } from '../src/modules/sync/sync-tables.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { resetTables } from './helpers/db.js';
import { type Member, type World, stockApi } from './helpers/stock-api.js';

// Phase D4: hardening (docs/phase-d-design.md section 11, D4 tests 1 and 2).
// The walkthrough (D4 test 3) is test/d4-walkthrough.spec.ts. The grants are
// pinned by the D1 inventories (test/step4-migrations.spec.ts and
// test/b5-hardening.spec.ts; decided in D4, answer 5).

// Three fixed seeds on every run; D4_SEED=<n> replays one exactly.
const SEEDS = process.env.D4_SEED ? [Number(process.env.D4_SEED)] : [11, 22, 33];

/** mulberry32, as in the C6 workload. */
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

type Row = Record<string, unknown> & { id: string };
type Copy = Record<string, Map<string, Row>>;
interface Change {
  table: string;
  op: 'upsert' | 'delete';
  id: string;
  row?: Row;
}
interface Product {
  productId: string;
  name: string;
  packs: { id: string; name: string; units: number }[];
  archived: boolean;
}
interface Shop extends World {
  products: Product[];
  locations: string[];
  barcodes: string[];
}

describe('D4: sync hardening', { timeout: 600_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;
  const IP = '198.51.100.160';

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, IP, 97_000_000);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await resetTables();
    api.resetOutboxes();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const get = (url: string, token: string) => t.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` }, remoteAddress: IP });

  // ---------------------------------------------------------------- the phone
  class Phone {
    copy: Copy = {};
    cursor = '';
    failures: string[] = [];
    constructor(readonly member: Member) {}

    private async read(url: string): Promise<unknown> {
      const res = await get(url, this.member.token);
      if (res.statusCode !== 200) {
        this.failures.push(`${url.split('?')[0]} ${res.statusCode} ${res.body}`);
        return null;
      }
      return res.json();
    }

    async snapshot(): Promise<void> {
      const copy: Copy = Object.fromEntries(SYNC_TABLE_NAMES.map((n) => [n, new Map<string, Row>()]));
      let p = (await this.read('/v1/sync/snapshot?limit=7')) as { table: string; rows: Row[]; next_cursor: string | null; next_table: string | null; start_cursor?: string } | null;
      if (!p) return;
      const start = p.start_cursor!;
      for (;;) {
        for (const r of p.rows) copy[p.table].set(r.id, r);
        const url = p.next_cursor
          ? `/v1/sync/snapshot?table=${p.table}&cursor=${encodeURIComponent(p.next_cursor)}&limit=7`
          : p.next_table
            ? `/v1/sync/snapshot?table=${p.next_table}&limit=7`
            : null;
        if (!url) break;
        p = (await this.read(url)) as typeof p;
        if (!p) return;
      }
      this.copy = copy;
      this.cursor = start;
    }

    /** One page of changes, applied; true if there is more. */
    async changes(limit: number): Promise<boolean> {
      const p = (await this.read(`/v1/sync/changes?cursor=${encodeURIComponent(this.cursor)}&limit=${limit}`)) as {
        changes: Change[];
        next_cursor: string;
        has_more: boolean;
      } | null;
      if (!p) return false;
      for (const c of p.changes) {
        if (c.op === 'upsert') this.copy[c.table].set(c.id, c.row!);
        else this.copy[c.table].delete(c.id);
      }
      // The cursor is replaced only after the whole page is applied.
      this.cursor = p.next_cursor;
      return p.has_more;
    }

    async drain(): Promise<void> {
      while (await this.changes(500));
    }

    plain() {
      return Object.fromEntries(Object.entries(this.copy).map(([n, m]) => [n, [...m.values()].sort((a, b) => (a.id < b.id ? -1 : 1))]));
    }
  }

  // ---------------------------------------------------------------- seeding
  async function shop(name: string): Promise<Shop> {
    const w = await api.world(name);
    const caseId = randomUUID();
    expect((await api.sendOne(w.owner.token, api.command('pack_type.upsert', { pack_type_id: caseId, product_id: w.maize.productId, name: 'case of 48', units_per_pack: 48, sell_price: '8000' }))).status).toBe('ACCEPTED');
    const store = await api.newLocation(w.owner, 'Back store');
    const barcode = `${name.replace(/\W/g, '')}000001`;
    expect((await api.sendOne(w.owner.token, api.command('barcode.add', { barcode, product_id: w.maize.productId, pack_type_id: w.maize.piece }))).status).toBe('ACCEPTED');
    await api.sendOne(w.manager.token, api.command('stock.receive', { location_id: w.loc, lines: [{ pack_type_id: caseId, quantity: 20 }, { pack_type_id: w.maize.carton, quantity: 30 }, { pack_type_id: w.maize.piece, quantity: 100 }] }));
    return {
      ...w,
      products: [{ productId: w.maize.productId, name: 'Maize flour 2kg', packs: [{ id: w.maize.piece, name: 'piece', units: 1 }, { id: w.maize.carton, name: 'carton of 24', units: 24 }, { id: caseId, name: 'case of 48', units: 48 }], archived: false }],
      locations: [w.loc, store],
      barcodes: [barcode],
    };
  }

  // ---------------------------------------------------------------- 1. randomized sync check
  it.each(SEEDS)('1. randomized sync, seed %i: each phone rebuilt by snapshot and changes equals a fresh snapshot', async (seed) => {
    const rnd = random(seed);
    const shops = [await shop('Duka A'), await shop('Duka B')];
    // Business A's phone is the attendant (no costs); business B's is the owner (costs).
    const phones = [new Phone(shops[0].attendant), new Phone(shops[1].owner)];
    for (const p of phones) await p.snapshot();
    let stop = false;
    const outcomes: string[] = [];
    let seq = 0;

    const phoneLoops = phones.map(async (phone, i) => {
      const own = random(seed * 1000 + i);
      while (!stop) {
        if (own.next() < 0.05) await phone.snapshot(); // a reinstall
        else await phone.changes(own.pick([3, 50, 500]));
        await new Promise((r) => setTimeout(r, own.int(0, 15)));
      }
    });

    const operation = async (s: Shop): Promise<void> => {
      const roll = rnd.next();
      const send = async (m: Member, type: string, payload: object) => {
        const r = await api.sendOne(m.token, api.command(type, payload));
        outcomes.push(r.status === 'REJECTED' ? `REJECTED:${r.reason}` : r.status);
      };
      if (roll < 0.1) {
        const p = await api.newProduct(s.owner, `Item ${seed}-${++seq}`);
        s.products.push({ productId: p.productId, name: `Item ${seed}-${seq}`, packs: [{ id: p.piece, name: 'piece', units: 1 }, { id: p.carton, name: 'carton of 24', units: 24 }], archived: false });
        outcomes.push('ACCEPTED');
      } else if (roll < 0.2) {
        const p = rnd.pick(s.products);
        p.name = `${p.name.split(' #')[0]} #${++seq}`;
        await send(s.owner, 'product.update', { product_id: p.productId, name: p.name });
      } else if (roll < 0.28) {
        const p = rnd.pick(s.products);
        const pack = rnd.pick(p.packs);
        await send(s.owner, 'pack_type.upsert', {
          pack_type_id: pack.id,
          product_id: p.productId,
          name: pack.name,
          units_per_pack: pack.units,
          sell_price: String(rnd.int(10, 9000)),
          cost_price: String(rnd.int(5, 8000)),
        });
      } else if (roll < 0.33) {
        const p = rnd.pick(s.products);
        p.archived = !p.archived;
        await send(s.owner, 'product.update', { product_id: p.productId, archived: p.archived });
      } else if (roll < 0.43) {
        if (s.barcodes.length > 0 && rnd.next() < 0.5) {
          const code = s.barcodes.splice(rnd.int(0, s.barcodes.length - 1), 1)[0];
          await send(s.owner, 'barcode.remove', { barcode: code });
        } else {
          const p = rnd.pick(s.products);
          const code = `${seed}${String(++seq).padStart(8, '0')}`;
          s.barcodes.push(code);
          await send(s.owner, 'barcode.add', { barcode: code, product_id: p.productId, pack_type_id: rnd.pick(p.packs).id });
        }
      } else if (roll < 0.48) {
        if (rnd.next() < 0.3) s.locations.push(await api.newLocation(s.owner, `Store ${++seq}`));
        else {
          // Never business A's default location: the held-open transaction
          // renames it, and a second rename would wait on its row lock.
          const renamable = s.locations.filter((l) => l !== shops[0].loc);
          expect((await api.call('PATCH', `/v1/locations/${rnd.pick(renamable)}`, s.owner.token, { name: `Shop ${++seq}` })).statusCode).toBe(200);
        }
        outcomes.push('ACCEPTED');
      } else {
        const p = s.products[0]; // maize: piece, carton, case
        const loc = rnd.pick(s.locations);
        const stockRoll = rnd.next();
        if (stockRoll < 0.25) await send(s.manager, 'stock.receive', { location_id: loc, lines: [{ pack_type_id: rnd.pick(p.packs).id, quantity: rnd.int(1, 20) }] });
        else if (stockRoll < 0.45) {
          const down = rnd.next() < 0.5;
          await send(s.manager, 'stock.adjust', { location_id: loc, pack_type_id: rnd.pick(p.packs).id, quantity_change: down ? -rnd.int(1, 3) : rnd.int(1, 3), reason: down ? 'DAMAGED' : 'FOUND' });
        } else if (stockRoll < 0.6) {
          await send(s.manager, 'stock.count', { location_id: loc, lines: [{ pack_type_id: rnd.pick(p.packs).id, expected_quantity: rnd.int(0, 30), counted_quantity: rnd.int(0, 30) }] });
        } else if (stockRoll < 0.8) {
          const [from, to] = rnd.next() < 0.5 ? [p.packs[2].id, p.packs[1].id] : [p.packs[1].id, p.packs[0].id];
          await send(s.manager, 'stock.convert', { location_id: loc, from_pack_type_id: from, to_pack_type_id: to, quantity: 1 });
        } else {
          await api.sell(s, loc, rnd.pick(p.packs).id, rnd.int(1, 4));
          outcomes.push('ACCEPTED');
        }
      }
    };

    // A transaction held open across several waves forces at least one
    // out-of-order commit every run (decided in D4, answer 1).
    let held: pg.Client | null = null;
    for (let wave = 0; wave < 15; wave++) {
      if (wave === 3) {
        held = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
        await held.connect();
        await held.query('BEGIN');
        await held.query("SELECT set_config('app.business_id', $1, true)", [shops[0].owner.businessId]);
        await held.query("UPDATE location SET name = 'Held open' WHERE id = $1", [shops[0].loc]);
      }
      if (wave === 9 && held) {
        await held.query('COMMIT');
        await held.end();
        held = null;
      }
      await Promise.all(Array.from({ length: 10 }, () => operation(rnd.pick(shops))));
    }
    stop = true;
    await Promise.all(phoneLoops);

    expect(outcomes).toHaveLength(150);
    for (const o of outcomes) expect(['ACCEPTED', 'FLAGGED:NEGATIVE_AFTER_COUNT', 'REJECTED:STOCK_INSUFFICIENT', 'REJECTED:INVALID_LINES', 'FLAGGED']).toContain(o.startsWith('FLAGGED') ? 'FLAGGED' : o);
    for (const [i, phone] of phones.entries()) {
      expect(phone.failures, `seed ${seed} phone ${i}`).toEqual([]);
      await phone.drain();
      const fresh = new Phone(phone.member);
      await fresh.snapshot();
      expect(phone.plain(), `seed ${seed} phone ${i}`).toEqual(fresh.plain());
      expect(phone.copy.location.get(shops[0].loc)?.name === 'Held open' || i === 1, `seed ${seed}: the held-open change arrived`).toBe(true);
    }
  });

  // ---------------------------------------------------------------- 2. logs
  it('2. no Phase D log line contains a product name, barcode, cost, cursor value or row content', async () => {
    const s = await shop('Duka A');
    const firstLine = t.logs.length;
    const marker = { name: 'ZEBRA-D4-PRODUCT', barcode: 'D4LOGCODE77', cost: '876543.21' };
    const p = await api.newProduct(s.owner, marker.name);
    expect((await api.sendOne(s.owner.token, api.command('barcode.add', { barcode: marker.barcode, product_id: p.productId, pack_type_id: p.piece }))).status).toBe('ACCEPTED');
    expect((await api.sendOne(s.owner.token, api.command('pack_type.upsert', { pack_type_id: p.piece, product_id: p.productId, name: 'piece', units_per_pack: 1, sell_price: '180', cost_price: marker.cost }))).status).toBe('ACCEPTED');

    const cursors: string[] = [];
    const ok = async (url: string, token: string) => {
      const res = await get(url, token);
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as Record<string, unknown>;
    };
    const first = await ok('/v1/sync/snapshot?limit=1', s.owner.token);
    cursors.push(first.start_cursor as string, first.next_cursor as string);
    const productPage = await ok('/v1/sync/snapshot?table=product&limit=1', s.owner.token);
    cursors.push(productPage.next_cursor as string);
    await ok(`/v1/sync/snapshot?table=product&cursor=${encodeURIComponent(productPage.next_cursor as string)}&limit=1`, s.owner.token);
    await ok('/v1/sync/snapshot?table=pack_type&limit=500', s.owner.token);
    await ok('/v1/sync/snapshot?table=product_barcode&limit=500', s.owner.token);
    const ch = await ok(`/v1/sync/changes?cursor=${encodeURIComponent(first.start_cursor as string)}&limit=2`, s.owner.token);
    cursors.push(ch.next_cursor as string);
    // A 410 (the owner's cursor, which carries costs, used by the attendant) and a 422 (tampered).
    const att = await get(`/v1/sync/changes?cursor=${encodeURIComponent(first.start_cursor as string)}`, s.attendant.token);
    expect((att as LightMyRequestResponse).statusCode).toBe(410);
    // The first character, which always changes the signed bytes (found in G1f: changing the last
    // characters of a base64url value can leave its bytes the same).
    const start = first.start_cursor as string;
    const tampered = `${start[0] === 'A' ? 'B' : 'A'}${start.slice(1)}`;
    expect((await get(`/v1/sync/changes?cursor=${encodeURIComponent(tampered)}`, s.owner.token)).statusCode).toBe(422);

    const raw = t.rawLogs();
    for (const [what, value] of Object.entries({ ...marker, ...Object.fromEntries(cursors.map((c, i) => [`cursor${i}`, c])) })) {
      expect(raw.includes(value), `${what} appears in the logs`).toBe(false);
    }
    const mine = t.logs.slice(firstLine);
    const syncLines = mine.filter((l) => typeof l.route === 'string' && (l.route as string).startsWith('/v1/sync/'));
    expect(syncLines.length).toBeGreaterThanOrEqual(8);
    expect(new Set(syncLines.map((l) => l.route))).toEqual(new Set(['/v1/sync/commands', '/v1/sync/snapshot', '/v1/sync/changes']));
    for (const line of mine) {
      const text = JSON.stringify(line);
      for (const bad of ['"rows"', '"changes"', 'cost_price', 'cursor=', 'start_cursor', 'next_cursor']) expect(text.includes(bad), `${bad} in a log line`).toBe(false);
    }
  });
});
