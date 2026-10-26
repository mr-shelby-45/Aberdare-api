import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { SignedCursor } from '../src/common/paging/signed-cursor.js';
import { SYNC_TABLE_NAMES } from '../src/modules/sync/sync-tables.js';
import { type TestApp, startTestApp } from './helpers/app.js';
import { asAdmin, resetTables } from './helpers/db.js';
import { type Member, type World, stockApi } from './helpers/stock-api.js';

// Phase E4: sales reads and sales in sync (docs/phase-e-design.md sections 7
// and 8). Numbers in test names refer to the E4 list in section 13.

type Row = { id: string } & Record<string, unknown>;
interface Change {
  table: string;
  op: 'upsert' | 'delete';
  id: string;
  row?: Row;
}
interface SnapshotPage {
  table: string;
  rows: Row[];
  next_cursor: string | null;
  next_table: string | null;
  start_cursor?: string;
}
type Copy = Record<string, Map<string, Row>>;

const DAY = 24 * 60 * 60 * 1000;

describe('E4: sales reads and sync', { timeout: 240_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, '198.51.100.182', 98_200_000);
  }, 60_000);

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await resetTables();
    api.resetOutboxes();
  });

  const get = (url: string, token: string) =>
    t.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` }, remoteAddress: '198.51.100.182' });
  const ok = async <T>(url: string, token: string): Promise<T> => {
    const res = await get(url, token);
    expect(res.statusCode, `${url} ${res.body}`).toBe(200);
    return res.json() as T;
  };
  const errorOf = (res: LightMyRequestResponse) => {
    const e = (res.json() as { error?: { code: string; message: string } }).error;
    return { status: res.statusCode, code: e?.code, message: e?.message };
  };
  const ago = (ms: number) => new Date(t.clock.now().getTime() - ms).toISOString();

  /** A sale of qty maize pieces at 100.00 by `by`, at `at` (ISO), with payments; returns its id. */
  async function sell(w: World, by: Member, opts: { at?: string; qty?: number; loc?: string; payments?: object[]; carton?: boolean } = {}): Promise<string> {
    const saleId = randomUUID();
    const lines = [{ pack_type_id: w.maize.piece, quantity: opts.qty ?? 1, unit_price: '100' }];
    if (opts.carton) lines.push({ pack_type_id: w.maize.carton, quantity: 1, unit_price: '4200' });
    const r = await api.sendOne(
      by.token,
      api.command('sale.create', { sale_id: saleId, local_ref: `R-${saleId.slice(0, 6)}`, location_id: opts.loc ?? w.loc, lines, payments: opts.payments ?? [] }, opts.at ?? t.clock.now().toISOString()),
    );
    expect(['ACCEPTED', 'FLAGGED'], JSON.stringify(r)).toContain(r.status);
    return saleId;
  }
  /** Void is E5; here the sale is voided directly as the superuser (the change_log trigger still runs). */
  const voidDirectly = (saleId: string, by: Member) =>
    asAdmin((c) =>
      c.query(
        `UPDATE sale SET status = 'VOIDED', voided_at = now(), voided_by_membership_id = $2, void_reason = 'MISTAKE', void_approved_by_membership_id = $2 WHERE id = $1`,
        [saleId, by.membershipId],
      ),
    );
  const setCost = async (w: World) =>
    expect(
      (await api.sendOne(w.owner.token, api.command('pack_type.upsert', { pack_type_id: w.maize.piece, product_id: w.maize.productId, name: 'piece', units_per_pack: 1, sell_price: '180', cost_price: '150' }))).status,
    ).toBe('ACCEPTED');
  const grant = async (w: World, m: Member, extra: string[]) =>
    expect((await api.call('PATCH', `/v1/staff/${m.membershipId}`, w.owner.token, { extra_permissions: extra })).statusCode).toBe(204);

  // ---------------------------------------------------------------- the phone
  async function snapshot(token: string, limit = 500): Promise<{ start: string; copy: Copy; pages: SnapshotPage[] }> {
    const copy: Copy = Object.fromEntries(SYNC_TABLE_NAMES.map((n) => [n, new Map<string, Row>()]));
    const pages: SnapshotPage[] = [];
    let p = await ok<SnapshotPage>(`/v1/sync/snapshot?limit=${limit}`, token);
    const start = p.start_cursor!;
    for (;;) {
      pages.push(p);
      for (const r of p.rows) {
        expect(copy[p.table].has(r.id), `${p.table} ${r.id} twice`).toBe(false);
        copy[p.table].set(r.id, r);
      }
      if (p.next_cursor) p = await ok<SnapshotPage>(`/v1/sync/snapshot?table=${p.table}&cursor=${encodeURIComponent(p.next_cursor)}&limit=${limit}`, token);
      else if (p.next_table) p = await ok<SnapshotPage>(`/v1/sync/snapshot?table=${p.next_table}&limit=${limit}`, token);
      else break;
    }
    return { start, copy, pages };
  }
  async function drain(token: string, cursor: string, limit = 200): Promise<{ all: Change[]; cursor: string }> {
    const all: Change[] = [];
    for (;;) {
      const p = await ok<{ changes: Change[]; next_cursor: string; has_more: boolean }>(`/v1/sync/changes?cursor=${encodeURIComponent(cursor)}&limit=${limit}`, token);
      all.push(...p.changes);
      cursor = p.next_cursor;
      if (!p.has_more) break;
    }
    return { all, cursor };
  }
  const apply = (copy: Copy, list: Change[]) => {
    for (const c of list) {
      if (c.op === 'upsert') copy[c.table].set(c.id, c.row!);
      else copy[c.table].delete(c.id);
    }
  };
  const ids = (copy: Copy, table: string) => new Set(copy[table].keys());

  // ---------------------------------------------------------------- 1. the list
  it('1. GET /v1/sales: newest first, filters, signed paging; attendants see only their own; another member\'s sale is 404', async () => {
    const w = await api.world();
    const b = await api.world('Duka B');
    const store = await api.newLocation(w.owner, 'Back store');
    const a1 = await sell(w, w.attendant, { at: ago(3 * DAY) });
    const a2 = await sell(w, w.attendant, { at: ago(2 * DAY), qty: 2, carton: true });
    const a3 = await sell(w, w.attendant, { at: ago(1 * DAY), loc: store });
    const m1 = await sell(w, w.manager, { at: ago(1.5 * DAY), payments: [{ method: 'CASH', amount: '40' }] });
    await sell(b, b.attendant, { at: ago(1 * DAY) });
    await voidDirectly(a2, w.manager);

    type List = { sales: Row[]; next_cursor: string | null };
    const list = (token: string, q = '') => ok<List>(`/v1/sales${q}`, token);
    const all = await list(w.manager.token);
    expect(all.sales.map((s) => s.id)).toEqual([a3, m1, a2, a1]);
    expect(all.next_cursor).toBeNull();
    expect(all.sales[1]).toEqual({
      id: m1,
      sale_number: 4,
      local_ref: `R-${m1.slice(0, 6)}`,
      location_id: w.loc,
      occurred_at: ago(1.5 * DAY),
      status: 'COMPLETED',
      total: '100.00',
      paid_total: '40.00',
      balance_due: '60.00',
      created_by: { membership_id: w.manager.membershipId, display_name: 'Baraka' },
      item_count: 1,
    });
    expect(all.sales[2]).toMatchObject({ status: 'VOIDED', item_count: 2, created_by: { display_name: 'Chebet' } });

    // Paging: two pages of two, then the cursor is bound to its filters.
    const p1 = await list(w.manager.token, '?limit=2');
    expect(p1.sales.map((s) => s.id)).toEqual([a3, m1]);
    const p2 = await list(w.manager.token, `?limit=2&cursor=${encodeURIComponent(p1.next_cursor!)}`);
    expect(p2).toEqual({ sales: all.sales.slice(2), next_cursor: null });
    const c = p1.next_cursor!;
    const tampered = `${c.slice(0, 8)}${c[8] === 'A' ? 'B' : 'A'}${c.slice(9)}`;
    for (const q of [`?limit=2&cursor=${encodeURIComponent(tampered)}`, `?limit=2&status=COMPLETED&cursor=${encodeURIComponent(c)}`, `?cursor=${encodeURIComponent(c)}&limit=2`.replace('limit=2', 'limit=2&created_by=' + w.manager.membershipId)]) {
      expect(errorOf(await get(`/v1/sales${q}`, w.manager.token)), q).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    }
    // An attendant's cursor is bound to their own sales: a manager cannot reuse it with created_by left out.
    const attPage = await list(w.attendant.token, '?limit=1');
    expect(errorOf(await get(`/v1/sales?limit=1&cursor=${encodeURIComponent(attPage.next_cursor!)}`, w.manager.token))).toMatchObject({ status: 422 });

    // Filters.
    expect((await list(w.manager.token, '?status=VOIDED')).sales.map((s) => s.id)).toEqual([a2]);
    expect((await list(w.manager.token, `?location_id=${store}`)).sales.map((s) => s.id)).toEqual([a3]);
    expect((await list(w.manager.token, `?from=${encodeURIComponent(ago(2.5 * DAY))}&to=${encodeURIComponent(ago(1.2 * DAY))}`)).sales.map((s) => s.id)).toEqual([m1, a2]);
    expect((await list(w.manager.token, `?from=${encodeURIComponent(ago(2 * DAY))}&to=${encodeURIComponent(ago(1.5 * DAY))}`)).sales.map((s) => s.id)).toEqual([a2]); // from inclusive, to exclusive
    expect((await list(w.manager.token, `?created_by=${w.attendant.membershipId}`)).sales.map((s) => s.id)).toEqual([a3, a2, a1]);
    for (const q of [`?business_id=${b.owner.businessId}`, '?limit=0', '?status=OPEN', '?created_by=x', `?from=${encodeURIComponent(ago(DAY))}&to=${encodeURIComponent(ago(2 * DAY))}`]) {
      expect(errorOf(await get(`/v1/sales${q}`, w.manager.token)), q).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    }

    // Attendants: only their own, created_by ignored.
    expect((await list(w.attendant.token)).sales.map((s) => s.id)).toEqual([a3, a2, a1]);
    expect((await list(w.attendant.token, `?created_by=${w.manager.membershipId}`)).sales.map((s) => s.id)).toEqual([a3, a2, a1]);
    // Another member's sale, an unknown id, another business's sale and a non-UUID: the same 404.
    const foreign = (await list(b.owner.token)).sales[0].id as string;
    const missing = [m1, randomUUID(), foreign, 'not-a-uuid'];
    for (const id of missing) expect(errorOf(await get(`/v1/sales/${id}`, w.attendant.token)), id).toEqual({ status: 404, code: 'SALE_NOT_FOUND', message: 'Sale not found.' });
    expect((await ok<Row>(`/v1/sales/${a1}`, w.attendant.token)).id).toBe(a1);
    // Another business never sees these sales.
    expect((await list(b.owner.token)).sales.map((s) => s.id)).toEqual([foreign]);
  });

  // ---------------------------------------------------------------- 2. one sale
  it('2. GET /v1/sales/:id: items, payments and void details; cost_price only with costs.view; another business\'s sale is 404', async () => {
    const w = await api.world();
    const b = await api.world('Duka B');
    await setCost(w);
    const s = await sell(w, w.attendant, { carton: true, payments: [{ method: 'CASH', amount: '100' }, { method: 'MPESA', amount: '50', mpesa_code: 'qa12ws34ed' }] });
    const dup = await sell(w, w.attendant, { payments: [{ method: 'MPESA', amount: '10', mpesa_code: 'QA12WS34ED' }] });

    const asManager = await ok<Row & { items: Row[]; payments: Row[] }>(`/v1/sales/${s}`, w.manager.token);
    expect(Object.keys(asManager).sort()).toEqual(
      [
        'id', 'sale_number', 'local_ref', 'location_id', 'device_id', 'created_by_membership_id', 'occurred_at', 'received_at', 'status', 'total', 'paid_total', 'balance_due',
        'total_mismatch', 'note', 'voided_at', 'voided_by_membership_id', 'void_reason', 'void_note', 'void_approval_id', 'void_approved_by_membership_id',
        'created_by', 'voided_by', 'void_approved_by', 'items', 'payments',
      ].sort(),
    );
    expect(asManager).toMatchObject({
      id: s,
      sale_number: 1,
      device_id: w.attendant.deviceId,
      status: 'COMPLETED',
      total: '4300.00',
      paid_total: '150.00',
      balance_due: '4150.00',
      voided_at: null,
      created_by: { membership_id: w.attendant.membershipId, display_name: 'Chebet' },
      voided_by: null,
      void_approved_by: null,
    });
    expect(asManager.items).toEqual([
      { id: expect.any(String), sale_id: s, line_no: 1, pack_type_id: w.maize.piece, product_name: 'Maize flour 2kg', pack_type_name: 'piece', quantity: 1, unit_price: '100.00', list_price: '180.00', line_total: '100.00' },
      { id: expect.any(String), sale_id: s, line_no: 2, pack_type_id: w.maize.carton, product_name: 'Maize flour 2kg', pack_type_name: 'carton of 24', quantity: 1, unit_price: '4200.00', list_price: '4200.00', line_total: '4200.00' },
    ]);
    expect(asManager.payments).toEqual(
      expect.arrayContaining([
        { id: expect.any(String), sale_id: s, method: 'CASH', amount: '100.00', mpesa_code: null, verified: false, duplicate: false, status: 'RECORDED', occurred_at: expect.any(String) },
        { id: expect.any(String), sale_id: s, method: 'MPESA', amount: '50.00', mpesa_code: 'QA12WS34ED', verified: false, duplicate: false, status: 'RECORDED', occurred_at: expect.any(String) },
      ]),
    );
    expect(asManager.payments).toHaveLength(2);
    expect((await ok<{ payments: Row[] }>(`/v1/sales/${dup}`, w.attendant.token)).payments.map((p) => p.duplicate)).toEqual([true]);

    // The owner sees costs (null when the pack type has none).
    const asOwner = await ok<{ items: Row[] }>(`/v1/sales/${s}`, w.owner.token);
    expect(asOwner.items.map((i) => i.cost_price)).toEqual(['150.00', null]);
    for (const i of asManager.items) expect(i).not.toHaveProperty('cost_price');

    // Void details.
    await voidDirectly(s, w.manager);
    expect(await ok<Row>(`/v1/sales/${s}`, w.attendant.token)).toMatchObject({
      status: 'VOIDED',
      voided_at: expect.any(String),
      void_reason: 'MISTAKE',
      voided_by: { membership_id: w.manager.membershipId, display_name: 'Baraka' },
      void_approved_by: { membership_id: w.manager.membershipId, display_name: 'Baraka' },
    });
    // Another business: 404, the same as a missing sale.
    expect(errorOf(await get(`/v1/sales/${s}`, b.owner.token))).toEqual({ status: 404, code: 'SALE_NOT_FOUND', message: 'Sale not found.' });
  });

  // ---------------------------------------------------------------- 3. two businesses
  it('3. identical data in two businesses never mixes in reads, snapshot or changes', async () => {
    const shops = [await api.world('Duka A'), await api.world('Duka B')];
    const starts = [];
    for (const w of shops) starts.push((await snapshot(w.owner.token)).start);
    const made = [];
    for (const w of shops) made.push([await sell(w, w.attendant, { payments: [{ method: 'MPESA', amount: '100', mpesa_code: 'SAMECODE99' }] }), await sell(w, w.manager)]);
    for (const [i, w] of shops.entries()) {
      const mine = new Set(made[i]);
      expect(new Set((await ok<{ sales: Row[] }>('/v1/sales', w.owner.token)).sales.map((s) => s.id))).toEqual(mine);
      const snap = await snapshot(w.owner.token);
      expect(ids(snap.copy, 'sale')).toEqual(mine);
      for (const p of snap.copy.payment.values()) expect(mine.has(p.sale_id as string)).toBe(true);
      for (const it of snap.copy.sale_item.values()) expect(mine.has(it.sale_id as string)).toBe(true);
      const changed = await drain(w.owner.token, starts[i]);
      for (const ch of changed.all.filter((x) => ['sale', 'sale_item', 'payment'].includes(x.table))) {
        expect(mine.has(ch.table === 'sale' ? ch.id : (ch.row!.sale_id as string))).toBe(true);
      }
      // Each business has its own original payment for the code.
      expect([...snap.copy.payment.values()].map((p) => p.duplicate)).toEqual([false]);
    }
  });

  // ---------------------------------------------------------------- 4. snapshot
  it('4. snapshot: sales of the last 30 days with their items and payments, paged, each once; attendants get their own; costs hidden', async () => {
    const w = await api.world();
    await setCost(w);
    const pay = [{ method: 'CASH', amount: '10' }];
    const recent = await sell(w, w.attendant, { at: ago(DAY), carton: true, payments: pay });
    const edgeIn = await sell(w, w.attendant, { at: ago(30 * DAY - 60_000), payments: pay });
    const edgeOut = await sell(w, w.attendant, { at: ago(30 * DAY + 60_000), payments: pay }); // children still sent (31-day grace)
    const old = await sell(w, w.attendant, { at: ago(31 * DAY + 60_000), payments: pay }); // nothing sent
    const mgr = await sell(w, w.manager, { at: ago(2 * DAY), payments: pay });

    const att = await snapshot(w.attendant.token, 2);
    expect(ids(att.copy, 'sale')).toEqual(new Set([recent, edgeIn]));
    const childSales = (table: string, copy: Copy) => [...copy[table].values()].map((r) => r.sale_id as string).sort();
    expect(childSales('sale_item', att.copy)).toEqual([recent, recent, edgeIn, edgeOut].sort());
    expect(childSales('payment', att.copy)).toEqual([recent, edgeIn, edgeOut].sort());
    expect(att.pages.filter((p) => p.table === 'sale_item').length).toBeGreaterThan(1); // paged
    for (const it of att.copy.sale_item.values()) expect(it).not.toHaveProperty('cost_price');
    // The same shapes as the detail read.
    const detail = await ok<Row & { items: Row[]; payments: Row[] }>(`/v1/sales/${recent}`, w.attendant.token);
    const { created_by: _c, voided_by: _v, void_approved_by: _a, items, payments, ...saleColumns } = detail;
    expect(att.copy.sale.get(recent)).toEqual(saleColumns);
    for (const it of items) expect(att.copy.sale_item.get(it.id as string)).toEqual(it);
    for (const p of payments) expect(att.copy.payment.get(p.id as string)).toEqual(p);

    const manager = await snapshot(w.manager.token);
    expect(ids(manager.copy, 'sale')).toEqual(new Set([recent, edgeIn, mgr]));
    expect(childSales('payment', manager.copy)).toEqual([recent, edgeIn, edgeOut, mgr].sort());
    expect(childSales('payment', manager.copy)).not.toContain(old);
    const owner = await snapshot(w.owner.token);
    expect(new Set([...owner.copy.sale_item.values()].filter((i) => i.sale_id === recent).map((i) => i.cost_price))).toEqual(new Set(['150.00', null]));
  });

  // ---------------------------------------------------------------- 5. changes
  it('5. changes: sales, payments and voids arrive once as current state; another member\'s sale never reaches an attendant, not even as a delete', async () => {
    const w = await api.world();
    const oldSale = await sell(w, w.attendant, { at: ago(40 * DAY) }); // outside any snapshot
    const att = await snapshot(w.attendant.token);
    const mgr = await snapshot(w.manager.token);
    expect(att.copy.sale.has(oldSale)).toBe(false);

    const s1 = await sell(w, w.attendant, { payments: [{ method: 'CASH', amount: '30' }] });
    const m1 = await sell(w, w.manager, { payments: [{ method: 'CASH', amount: '20' }] });
    expect((await api.sendOne(w.manager.token, api.command('payment.attach', { sale_id: s1, payments: [{ method: 'CASH', amount: '50' }] }))).status).toBe('ACCEPTED');
    expect((await api.sendOne(w.manager.token, api.command('payment.attach', { sale_id: m1, payments: [{ method: 'CASH', amount: '5' }] }))).status).toBe('ACCEPTED');
    await voidDirectly(oldSale, w.manager);

    const a = await drain(w.attendant.token, att.start); // one page: repeats of a record collapse only within a page (Phase D3)
    const sales = a.all.filter((c) => c.table === 'sale');
    expect(sales.map((c) => c.id).sort()).toEqual([s1, oldSale].sort()); // each once
    expect(sales.find((c) => c.id === s1)!.row).toMatchObject({ paid_total: '80.00', balance_due: '20.00' }); // current state
    expect(sales.find((c) => c.id === oldSale)!.row).toMatchObject({ status: 'VOIDED' }); // a void of an old sale still arrives
    const s1Payments = a.all.filter((c) => c.table === 'payment');
    expect(s1Payments.map((c) => c.row!.sale_id)).toEqual([s1, s1]);
    expect(a.all.filter((c) => c.table === 'sale_item').map((c) => c.row!.sale_id)).toEqual([s1]);
    for (const c of a.all.filter((x) => x.table === 'sale_item')) expect(c.row).not.toHaveProperty('cost_price');
    // Nothing of the manager's sale, and no delete markers in sale tables.
    expect(JSON.stringify(a.all)).not.toContain(m1);
    expect(a.all.filter((c) => c.op === 'delete')).toEqual([]);
    // The cursor moved past the hidden rows: nothing more to read.
    expect((await drain(w.attendant.token, a.cursor)).all).toEqual([]);
    // Pages of 3 log rows (hidden rows still move the cursor) end in the same state.
    const small = await drain(w.attendant.token, att.start, 3);
    expect(JSON.stringify(small.all)).not.toContain(m1);
    const viaPages: Copy = Object.fromEntries(SYNC_TABLE_NAMES.map((n) => [n, new Map<string, Row>()]));
    const viaOne: Copy = Object.fromEntries(SYNC_TABLE_NAMES.map((n) => [n, new Map<string, Row>()]));
    apply(viaPages, small.all);
    apply(viaOne, a.all);
    expect(viaPages).toEqual(viaOne);

    // The phone's copy now equals a fresh snapshot (the 40-day-old sale is only in the copy).
    apply(att.copy, a.all);
    att.copy.sale.delete(oldSale);
    expect(Object.fromEntries(Object.entries(att.copy).map(([n, m]) => [n, [...m.keys()].sort()]))).toEqual(
      Object.fromEntries(Object.entries((await snapshot(w.attendant.token)).copy).map(([n, m]) => [n, [...m.keys()].sort()])),
    );
    // The manager receives both sales.
    const m = await drain(w.manager.token, mgr.start);
    expect(new Set(m.all.filter((c) => c.table === 'sale').map((c) => c.id))).toEqual(new Set([s1, m1, oldSale]));
  });

  it('5. out-of-order commits: a payment change committed late still reaches the phone, none skipped', async () => {
    const w = await api.world();
    const s1 = await sell(w, w.attendant, { qty: 5 });
    const { start, copy } = await snapshot(w.attendant.token);
    let cursor = start;
    const poll = async () => {
      const d = await drain(w.attendant.token, cursor);
      apply(copy, d.all);
      cursor = d.cursor;
      return d.all;
    };
    // T1 changes the sale first (lower change_log id) and stays open, as app_user.
    const t1 = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await t1.connect();
    let s2 = '';
    try {
      await t1.query('BEGIN');
      await t1.query("SELECT set_config('app.business_id', $1, true)", [w.owner.businessId]);
      await t1.query('UPDATE sale SET paid_total = paid_total + 7, balance_due = GREATEST(total - (paid_total + 7), 0) WHERE id = $1', [s1]);
      s2 = await sell(w, w.attendant);
      const whileOpen = await poll();
      expect(whileOpen.map((c) => c.id)).not.toContain(s1);
      expect(whileOpen.map((c) => c.id)).not.toContain(s2); // held back too: only rows below the oldest open transaction are handed out (Phase D1)
      await t1.query('COMMIT');
    } finally {
      await t1.end();
    }
    await poll();
    expect(copy.sale.get(s1)).toMatchObject({ paid_total: '7.00', balance_due: '493.00' });
    expect(copy.sale.has(s2)).toBe(true);
    const fresh = (await snapshot(w.attendant.token)).copy;
    for (const table of ['sale', 'sale_item', 'payment']) {
      expect([...copy[table].values()].sort((x, y) => (x.id < y.id ? -1 : 1)), table).toEqual([...fresh[table].values()].sort((x, y) => (x.id < y.id ? -1 : 1)));
    }
  });

  // ---------------------------------------------------------------- 6. visibility changes
  it('6. gaining costs.view or gaining or losing sales.void makes the cursor 410; the new snapshot shows costs and others\' sales', async () => {
    const w = await api.world();
    await setCost(w);
    await sell(w, w.manager);
    const before = await snapshot(w.attendant.token);
    expect(before.copy.sale.size).toBe(0);
    const required = { status: 410, code: 'SNAPSHOT_REQUIRED', message: expect.any(String) };

    // sales.void granted: the old cursor is refused; the new snapshot has the manager's sale.
    await grant(w, w.attendant, ['sales.void']);
    expect(errorOf(await get(`/v1/sync/changes?cursor=${encodeURIComponent(before.start)}`, w.attendant.token))).toEqual(required);
    const promoted = await snapshot(w.attendant.token);
    expect(promoted.copy.sale.size).toBe(1);
    // ... and taken away again: refused the other way round.
    await grant(w, w.attendant, []);
    expect(errorOf(await get(`/v1/sync/changes?cursor=${encodeURIComponent(promoted.start)}`, w.attendant.token))).toEqual(required);

    // costs.view granted to the manager: 410, and the new snapshot shows item costs.
    const mgr = await snapshot(w.manager.token);
    for (const it of mgr.copy.sale_item.values()) expect(it).not.toHaveProperty('cost_price');
    await grant(w, w.manager, ['costs.view']);
    expect(errorOf(await get(`/v1/sync/changes?cursor=${encodeURIComponent(mgr.start)}`, w.manager.token))).toEqual(required);
    expect([...(await snapshot(w.manager.token)).copy.sale_item.values()].map((i) => i.cost_price)).toEqual(['150.00']);

    // A changes cursor from before E4 (no all_sales) is refused like a tampered one.
    const legacy = t.app.get(SignedCursor, { strict: false }).sign('sync-changes', { business_id: w.owner.businessId, txid: '0', id: '0', costs: false });
    expect(errorOf(await get(`/v1/sync/changes?cursor=${encodeURIComponent(legacy)}`, w.attendant.token))).toEqual({ status: 422, code: 'VALIDATION_FAILED', message: 'The cursor is not valid.' });
  });
});
