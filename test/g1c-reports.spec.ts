import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { type TestApp, startTestApp } from './helpers/app.js';
import { resetTables } from './helpers/db.js';
import { type Member, stockApi } from './helpers/stock-api.js';

// Phase G1c: the stock report and shrinkage (docs/phase-g1-design.md section
// 11, G1c). Numbers in test names refer to that list. Every expected value is
// a literal worked out by hand from the fixture below; none is recomputed
// with the report's own SQL.
//
// Products (cost price; "-" = none): Soda piece SP 35.50 and crate of 24 SC
// 800.00; Chai piece CP -; Salt piece XP 12.00; Gum piece GP 3.00 (archived
// at the end). Locations: Main shop L1, Branch L2, Van V (field, Otieno).
// Wanjiru and Amina are managers (Amina has costs.view as an extra).
//
// Receive: L1 SP 100, SC 10, CP 50, GP 20; L2 SP 40, CP 2, XP 5. Issue L1 -> V: SP 20, SC 2.
// Movements (Nairobi times):
//   M0 Wanjiru L1 SP DAMAGED -1          2026-10-19 23:59:59 (before the range)
//   M1 Wanjiru L1 SP DAMAGED -3          2026-10-20 10:00
//   M2 Amina   L1 SC EXPIRED -1 (24 pc)  2026-10-20 11:00
//   M3 Wanjiru L2 CP LOST -2             2026-10-20 23:59:59   (CP at L2 is now 0)
//   M4 Amina   L1 SP FOUND +1            2026-10-21 00:00:00
//   M5 Wanjiru L1 count: SP 77 -> 75 (-2), CP 50 -> 52 (+2)   2026-10-21 09:00
//   M6 Wanjiru L2 SP SUPPLIER_RETURN -5  2026-10-21 10:00 (not shrinkage)
//   M7 Wanjiru L1 SP CORRECTION -1       2026-10-21 10:30 (not shrinkage)
//   M8 Amina   L1 GP OTHER -2            2026-10-21 11:00 (not shrinkage)
//   sale: Baraka sells 6 XP at L2 (5 in stock: XP at L2 is now -1)   2026-10-21 12:00
//   sale: Otieno sells 5 SP from the van                            2026-10-21 13:00
//   settlement of the van, closed by Wanjiru: SP counted 13 of 15 (LOST -2), SC 3 of 2 (FOUND +1 = 24 pc)   18:00
//   M9 Wanjiru L1 SP DAMAGED -4          2026-10-22 09:00 (after the range)
// Final balances: L1 SP 70, SC 7, CP 52, GP 18 (archived); L2 SP 35, CP 0, XP -1; V SP 13, SC 3.

// Report routes allow 30 requests a minute per member (G1a): the tests spread
// their requests over the owner, Amina and Wanjiru.
const IP = '198.51.100.212';
const PHONE_BASE = 98_000_000;

interface StockFigures {
  pieces: number;
  pools: number;
  negative_pools: number;
  value_at_cost?: string;
  pools_without_cost?: number;
}
interface StockReport {
  group_by: string;
  totals: StockFigures;
  rows: (StockFigures & { packs?: { pack_type: { id: string; name: string; units_per_pack: number }; quantity: number }[] } & Record<string, unknown>)[];
}
interface ShrinkFigures {
  units_lost: number;
  units_found: number;
  net_units: number;
  value_lost_at_cost?: string;
  value_found_at_cost?: string;
  net_value_at_cost?: string;
  movements_without_cost?: number;
}
interface Shrinkage {
  range: { from: string; to: string };
  group_by: string;
  unit: string;
  totals: ShrinkFigures;
  rows: (ShrinkFigures & Record<string, unknown>)[];
}
interface Balance {
  location_id: string;
  product_id: string;
  pack_type_id: string;
  units_per_pack: number;
  quantity: number;
}

describe('G1c: stock and shrinkage reports', { timeout: 300_000 }, () => {
  let t: TestApp;
  let api: ReturnType<typeof stockApi>;
  let owner: Member;
  let wanjiru: Member;
  let amina: Member;
  let baraka: Member;
  let otieno: Member;
  let L1: string;
  let L2: string;
  let V: string;
  let ids: { soda: string; chai: string; salt: string; gum: string; SP: string; SC: string; CP: string; XP: string; GP: string };

  beforeAll(async () => {
    t = await startTestApp();
    api = stockApi(t, IP, PHONE_BASE);
    await resetTables();
    api.resetOutboxes();
    ({ owner, wanjiru, amina, baraka, otieno, L1, L2, V, ids } = await fixture());
  }, 240_000);

  afterAll(async () => {
    await t.app.close();
  });

  const get = (url: string, token: string) => t.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` }, remoteAddress: IP });
  const ok = async <T>(url: string, token: string): Promise<T> => {
    const res = await get(url, token);
    expect(res.statusCode, `${url} ${res.body}`).toBe(200);
    return res.json() as T;
  };
  const errorOf = (res: LightMyRequestResponse) => ({ status: res.statusCode, code: (res.json() as { error?: { code: string } }).error?.code });
  const stock = (query: string, token: string) => ok<StockReport>(`/v1/reports/stock${query ? `?${query}` : ''}`, token);
  const shrinkage = (query: string, token: string) => ok<Shrinkage>(`/v1/reports/shrinkage?${query}`, token);

  // Nairobi wall time (UTC+3) as an ISO instant, for command envelopes.
  const nbo = (local: string) => new Date(Date.parse(`${local}+03:00`)).toISOString();

  async function accepted(m: Member, type: string, payload: object, at?: string) {
    const r = await api.sendOne(m.token, api.command(type, payload, at ? nbo(at) : undefined));
    expect(['ACCEPTED', 'FLAGGED'], `${type} ${JSON.stringify(r)}`).toContain(r.status);
    return r;
  }
  async function product(o: Member, name: string, packs: { name: string; units: number; sell: string; cost: string | null }[]) {
    const productId = randomUUID();
    const packIds = packs.map(() => randomUUID());
    await accepted(o, 'product.create', {
      product_id: productId,
      name,
      pack_types: packs.map((p, i) => ({
        pack_type_id: packIds[i],
        name: p.name,
        units_per_pack: p.units,
        sell_price: p.sell,
        ...(p.cost === null ? {} : { cost_price: p.cost }),
      })),
    });
    return { productId, packIds };
  }
  const adjust = (m: Member, loc: string, pack: string, change: number, reason: string, at: string) =>
    accepted(m, 'stock.adjust', { location_id: loc, pack_type_id: pack, quantity_change: change, reason }, at);
  const firstLocation = async (o: Member) => api.json<{ locations: { id: string }[] }>(await api.call('GET', '/v1/locations', o.token)).locations[0].id;

  async function fixture() {
    const o = await api.signupOwner('Duka la Hasara');
    const w = await api.activeStaff(o, 'MANAGER', 'Wanjiru');
    const am = await api.activeStaff(o, 'MANAGER', 'Amina');
    expect((await api.call('PATCH', `/v1/staff/${am.membershipId}`, o.token, { extra_permissions: ['costs.view'] })).statusCode).toBe(204);
    const b = await api.activeStaff(o, 'ATTENDANT', 'Baraka');
    const f = await api.activeStaff(o, 'FIELD_ATTENDANT', 'Otieno');
    const l1 = await firstLocation(o);
    const l2 = await api.newLocation(o, 'Branch');
    const v = api.json<{ id: string }>(await api.post('/v1/locations', { name: 'Van', kind: 'FIELD', assigned_membership_id: f.membershipId }, o.token)).id;

    const soda = await product(o, 'Soda', [
      { name: 'piece', units: 1, sell: '50.00', cost: '35.50' },
      { name: 'crate of 24', units: 24, sell: '1100.00', cost: '800.00' },
    ]);
    const chai = await product(o, 'Chai', [{ name: 'piece', units: 1, sell: '33.33', cost: null }]);
    const salt = await product(o, 'Salt', [{ name: 'piece', units: 1, sell: '20.00', cost: '12.00' }]);
    const gum = await product(o, 'Gum', [{ name: 'piece', units: 1, sell: '5.00', cost: '3.00' }]);
    const [SP, SC] = soda.packIds;
    const [CP] = chai.packIds;
    const [XP] = salt.packIds;
    const [GP] = gum.packIds;

    await accepted(w, 'stock.receive', { location_id: l1, lines: [{ pack_type_id: SP, quantity: 100 }, { pack_type_id: SC, quantity: 10 }, { pack_type_id: CP, quantity: 50 }, { pack_type_id: GP, quantity: 20 }] }, '2026-10-19T08:00:00');
    await accepted(w, 'stock.receive', { location_id: l2, lines: [{ pack_type_id: SP, quantity: 40 }, { pack_type_id: CP, quantity: 2 }, { pack_type_id: XP, quantity: 5 }] }, '2026-10-19T08:00:00');
    await accepted(w, 'stock.issue', { from_location_id: l1, to_location_id: v, lines: [{ pack_type_id: SP, quantity: 20 }, { pack_type_id: SC, quantity: 2 }] }, '2026-10-19T09:00:00');

    await adjust(w, l1, SP, -1, 'DAMAGED', '2026-10-19T23:59:59');
    await adjust(w, l1, SP, -3, 'DAMAGED', '2026-10-20T10:00:00');
    await adjust(am, l1, SC, -1, 'EXPIRED', '2026-10-20T11:00:00');
    await adjust(w, l2, CP, -2, 'LOST', '2026-10-20T23:59:59');
    await adjust(am, l1, SP, 1, 'FOUND', '2026-10-21T00:00:00');
    await accepted(w, 'stock.count', { location_id: l1, lines: [{ pack_type_id: SP, expected_quantity: 77, counted_quantity: 75 }, { pack_type_id: CP, expected_quantity: 50, counted_quantity: 52 }] }, '2026-10-21T09:00:00');
    await adjust(w, l2, SP, -5, 'SUPPLIER_RETURN', '2026-10-21T10:00:00');
    await adjust(w, l1, SP, -1, 'CORRECTION', '2026-10-21T10:30:00');
    await adjust(am, l1, GP, -2, 'OTHER', '2026-10-21T11:00:00');
    await accepted(b, 'sale.create', { sale_id: randomUUID(), local_ref: 'XP6', location_id: l2, lines: [{ pack_type_id: XP, quantity: 6, unit_price: '20.00' }], payments: [{ method: 'CASH', amount: '120.00' }] }, '2026-10-21T12:00:00');
    await accepted(f, 'sale.create', { sale_id: randomUUID(), local_ref: 'VAN1', location_id: v, lines: [{ pack_type_id: SP, quantity: 5, unit_price: '50.00' }], payments: [{ method: 'CASH', amount: '250.00' }] }, '2026-10-21T13:00:00');
    // A close needs the attendant's phone synced recently; a sync read stamps it.
    expect((await api.call('GET', '/v1/sync/snapshot?limit=1', f.token)).statusCode).toBe(200);
    const close = await accepted(w, 'settlement.close', {
      settlement_id: randomUUID(),
      field_location_id: v,
      cash_received: '250.00',
      lines: [
        { pack_type_id: SP, counted_quantity: 13 },
        { pack_type_id: SC, counted_quantity: 3 },
      ],
    }, '2026-10-21T18:00:00');
    const closed = close.result as { lines: { pack_type_id: string; variance: number }[] };
    expect(Object.fromEntries(closed.lines.map((l) => [l.pack_type_id, l.variance]))).toEqual({ [SP]: -2, [SC]: 1 });
    await adjust(w, l1, SP, -4, 'DAMAGED', '2026-10-22T09:00:00');
    await accepted(o, 'product.update', { product_id: gum.productId, archived: true });
    return {
      owner: o,
      wanjiru: w,
      amina: am,
      baraka: b,
      otieno: f,
      L1: l1,
      L2: l2,
      V: v,
      ids: { soda: soda.productId, chai: chai.productId, salt: salt.productId, gum: gum.productId, SP, SC, CP, XP, GP },
    };
  }

  const byId = <T extends { pack_type: { id: string } }>(packs: T[]) => [...packs].sort((a, b) => (a.pack_type.id < b.pack_type.id ? -1 : 1));

  // ---------------------------------------------------------------- 1. the stock report
  it('1. stock report equals the literals and GET /v1/stock; negative pools shown; value_at_cost only with costs.view', async () => {
    const byProduct = await stock('', owner.token);
    expect(byProduct.group_by).toBe('product');
    expect(byProduct.totals).toEqual({ pieces: 409, pools: 7, negative_pools: 1, value_at_cost: '12189.00', pools_without_cost: 1 });
    expect(byProduct.rows.map((r) => ({ ...r, packs: byId(r.packs!) }))).toEqual([
      // Positive but no cost: counted in pools_without_cost, not valued.
      { product: { id: ids.chai, name: 'Chai' }, pieces: 52, pools: 1, negative_pools: 0, value_at_cost: '0.00', pools_without_cost: 1, packs: [{ pack_type: { id: ids.CP, name: 'piece', units_per_pack: 1 }, quantity: 52 }] },
      // A negative balance is shown and counted, never valued.
      { product: { id: ids.salt, name: 'Salt' }, pieces: -1, pools: 1, negative_pools: 1, value_at_cost: '0.00', pools_without_cost: 0, packs: [{ pack_type: { id: ids.XP, name: 'piece', units_per_pack: 1 }, quantity: -1 }] },
      // 118 pieces + 10 crates of 24; 118 x 35.50 + 10 x 800.00.
      {
        product: { id: ids.soda, name: 'Soda' },
        pieces: 358,
        pools: 5,
        negative_pools: 0,
        value_at_cost: '12189.00',
        pools_without_cost: 0,
        packs: byId([
          { pack_type: { id: ids.SP, name: 'piece', units_per_pack: 1 }, quantity: 118 },
          { pack_type: { id: ids.SC, name: 'crate of 24', units_per_pack: 24 }, quantity: 10 },
        ]),
      },
    ]);

    const byLocation = await stock('group_by=location', owner.token);
    expect(byLocation.totals).toEqual(byProduct.totals);
    expect(byLocation.rows).toEqual([
      { location: { id: L2, name: 'Branch' }, pieces: 34, pools: 2, negative_pools: 1, value_at_cost: '1242.50', pools_without_cost: 0 },
      { location: { id: L1, name: 'Main shop' }, pieces: 290, pools: 3, negative_pools: 0, value_at_cost: '8085.00', pools_without_cost: 1 },
      { location: { id: V, name: 'Van' }, pieces: 85, pools: 2, negative_pools: 0, value_at_cost: '2861.50', pools_without_cost: 0 },
    ]);

    // The switches: Chai's zero pool at L2, the archived Gum (18 x 3.00).
    expect((await stock('include_zero=true', owner.token)).totals).toEqual({ pieces: 409, pools: 8, negative_pools: 1, value_at_cost: '12189.00', pools_without_cost: 1 });
    const archived = await stock('include_archived=true', owner.token);
    expect(archived.totals).toEqual({ pieces: 427, pools: 8, negative_pools: 1, value_at_cost: '12243.00', pools_without_cost: 1 });
    expect(archived.rows.find((r) => (r.product as { id: string }).id === ids.gum)).toMatchObject({ pieces: 18, pools: 1, value_at_cost: '54.00' });
    expect((await stock('include_zero=true&include_archived=true', owner.token)).totals.pools).toBe(9);
    expect((await stock(`location_id=${L2}`, owner.token)).rows).toEqual([
      { product: { id: ids.salt, name: 'Salt' }, pieces: -1, pools: 1, negative_pools: 1, value_at_cost: '0.00', pools_without_cost: 0, packs: [{ pack_type: { id: ids.XP, name: 'piece', units_per_pack: 1 }, quantity: -1 }] },
      { product: { id: ids.soda, name: 'Soda' }, pieces: 35, pools: 1, negative_pools: 0, value_at_cost: '1242.50', pools_without_cost: 0, packs: [{ pack_type: { id: ids.SP, name: 'piece', units_per_pack: 1 }, quantity: 35 }] },
    ]);

    // Cross-check with GET /v1/stock, paged, as a manager, for each set of filters.
    for (const filters of ['', 'include_zero=true', 'include_archived=true', 'include_zero=true&include_archived=true', `location_id=${L2}`, `location_id=${V}`]) {
      const pools: Balance[] = [];
      let cursor: string | null = null;
      do {
        const sep = filters ? '&' : '';
        const page: { balances: Balance[]; next_cursor: string | null } = await ok(
          `/v1/stock?${filters}${sep}limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          wanjiru.token,
        );
        pools.push(...page.balances);
        cursor = page.next_cursor;
      } while (cursor);
      const report = await stock(filters, wanjiru.token);
      expect(report.totals.pools, filters).toBe(pools.length);
      expect(report.totals.negative_pools, filters).toBe(pools.filter((p) => p.quantity < 0).length);
      expect(report.totals.pieces, filters).toBe(pools.reduce((s, p) => s + p.quantity * p.units_per_pack, 0));
      for (const row of report.rows) {
        const id = (row.product as { id: string }).id;
        const mine = pools.filter((p) => p.product_id === id);
        expect(row.pieces, `${filters} ${id}`).toBe(mine.reduce((s, p) => s + p.quantity * p.units_per_pack, 0));
        for (const pack of row.packs!) {
          expect(pack.quantity, `${filters} ${pack.pack_type.id}`).toBe(mine.filter((p) => p.pack_type_id === pack.pack_type.id).reduce((s, p) => s + p.quantity, 0));
        }
      }
      expect(new Set(report.rows.map((r) => (r.product as { id: string }).id)), filters).toEqual(new Set(pools.map((p) => p.product_id)));
    }

    // Without costs.view: no value_at_cost or pools_without_cost anywhere; with it (Amina, a manager): the same figures as the owner.
    for (const query of ['', 'group_by=location', 'include_archived=true']) {
      const res = await get(`/v1/reports/stock${query ? `?${query}` : ''}`, wanjiru.token);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('value_at_cost');
      expect(res.body).not.toContain('without_cost');
      expect(res.body).not.toContain('12189.00');
    }
    expect((await stock('', wanjiru.token)).totals).toEqual({ pieces: 409, pools: 7, negative_pools: 1 });
    expect(await stock('', amina.token)).toEqual(byProduct);
  });

  // ---------------------------------------------------------------- 2. shrinkage
  it('2. shrinkage equals the literals for every group_by: reasons, counts, settlements against the attendant, exclusions, pieces, costs only with costs.view', async () => {
    const range = 'from=2026-10-20&to=2026-10-21';
    const byReason = await shrinkage(range, owner.token);
    expect(byReason.group_by).toBe('reason');
    expect(byReason.unit).toBe('pieces');
    const totals = { units_lost: 33, units_found: 27, net_units: -6, value_lost_at_cost: '1048.50', value_found_at_cost: '835.50', net_value_at_cost: '-213.00', movements_without_cost: 2 };
    expect(byReason.totals).toEqual(totals);
    expect(byReason.rows).toEqual([
      { reason: 'DAMAGED', units_lost: 3, units_found: 0, net_units: -3, value_lost_at_cost: '106.50', value_found_at_cost: '0.00', net_value_at_cost: '-106.50', movements_without_cost: 0 },
      // One crate of 24.
      { reason: 'EXPIRED', units_lost: 24, units_found: 0, net_units: -24, value_lost_at_cost: '800.00', value_found_at_cost: '0.00', net_value_at_cost: '-800.00', movements_without_cost: 0 },
      // Chai has no cost: counted, not valued.
      { reason: 'LOST', units_lost: 2, units_found: 0, net_units: -2, value_lost_at_cost: '0.00', value_found_at_cost: '0.00', net_value_at_cost: '0.00', movements_without_cost: 1 },
      { reason: 'FOUND', units_lost: 0, units_found: 1, net_units: 1, value_lost_at_cost: '0.00', value_found_at_cost: '35.50', net_value_at_cost: '35.50', movements_without_cost: 0 },
      { reason: 'COUNT', units_lost: 2, units_found: 2, net_units: 0, value_lost_at_cost: '71.00', value_found_at_cost: '0.00', net_value_at_cost: '-71.00', movements_without_cost: 1 },
      // The van: 2 pieces short, a crate of 24 over.
      { reason: 'SETTLEMENT', units_lost: 2, units_found: 24, net_units: 22, value_lost_at_cost: '71.00', value_found_at_cost: '800.00', net_value_at_cost: '729.00', movements_without_cost: 0 },
    ]);

    const byPerson = await shrinkage(`${range}&group_by=person`, owner.token);
    expect(byPerson.totals).toEqual(totals);
    expect(byPerson.rows).toEqual([
      { person: { membership_id: amina.membershipId, display_name: 'Amina' }, units_lost: 24, units_found: 1, net_units: -23, value_lost_at_cost: '800.00', value_found_at_cost: '35.50', net_value_at_cost: '-764.50', movements_without_cost: 0 },
      // The settlement's adjustments are Otieno's (the attendant), not Wanjiru's (who closed it).
      { person: { membership_id: otieno.membershipId, display_name: 'Otieno' }, units_lost: 2, units_found: 24, net_units: 22, value_lost_at_cost: '71.00', value_found_at_cost: '800.00', net_value_at_cost: '729.00', movements_without_cost: 0 },
      { person: { membership_id: wanjiru.membershipId, display_name: 'Wanjiru' }, units_lost: 7, units_found: 2, net_units: -5, value_lost_at_cost: '177.50', value_found_at_cost: '0.00', net_value_at_cost: '-177.50', movements_without_cost: 2 },
    ]);

    const byLocation = await shrinkage(`${range}&group_by=location`, owner.token);
    expect(byLocation.totals).toEqual(totals);
    expect(byLocation.rows).toEqual([
      { location: { id: L2, name: 'Branch' }, units_lost: 2, units_found: 0, net_units: -2, value_lost_at_cost: '0.00', value_found_at_cost: '0.00', net_value_at_cost: '0.00', movements_without_cost: 1 },
      { location: { id: L1, name: 'Main shop' }, units_lost: 29, units_found: 3, net_units: -26, value_lost_at_cost: '977.50', value_found_at_cost: '35.50', net_value_at_cost: '-942.00', movements_without_cost: 1 },
      { location: { id: V, name: 'Van' }, units_lost: 2, units_found: 24, net_units: 22, value_lost_at_cost: '71.00', value_found_at_cost: '800.00', net_value_at_cost: '729.00', movements_without_cost: 0 },
    ]);

    // Pack types rolled up into pieces; Salt (supplier return) and Gum (OTHER) are absent.
    const byProduct = await shrinkage(`${range}&group_by=product`, owner.token);
    expect(byProduct.totals).toEqual(totals);
    expect(byProduct.rows).toEqual([
      { product: { id: ids.chai, name: 'Chai' }, units_lost: 2, units_found: 2, net_units: 0, value_lost_at_cost: '0.00', value_found_at_cost: '0.00', net_value_at_cost: '0.00', movements_without_cost: 2 },
      { product: { id: ids.soda, name: 'Soda' }, units_lost: 31, units_found: 25, net_units: -6, value_lost_at_cost: '1048.50', value_found_at_cost: '835.50', net_value_at_cost: '-213.00', movements_without_cost: 0 },
    ]);

    // Without costs.view only the units; with it (Amina) everything.
    const plain = await shrinkage(`${range}&group_by=person`, wanjiru.token);
    expect(plain.totals).toEqual({ units_lost: 33, units_found: 27, net_units: -6 });
    for (const row of plain.rows) expect(Object.keys(row).sort()).toEqual(['net_units', 'person', 'units_found', 'units_lost']);
    for (const query of [range, `${range}&group_by=product`]) {
      const body = (await get(`/v1/reports/shrinkage?${query}`, wanjiru.token)).body;
      expect(body).not.toContain('value');
      expect(body).not.toContain('without_cost');
    }
    expect(await shrinkage(`${range}&group_by=person`, amina.token)).toEqual(byPerson);
  });

  // ---------------------------------------------------------------- 3. Nairobi days
  it('3. the range applies to the movements’ occurred_at in Nairobi days', async () => {
    const day = async (d: string) => (await shrinkage(`from=${d}&to=${d}`, amina.token)).totals;
    // M0 at 23:59:59 on the 19th (20:59:59 UTC) is the 19th's.
    expect(await day('2026-10-19')).toMatchObject({ units_lost: 1, units_found: 0, net_units: -1 });
    // M1, M2 and M3 (23:59:59): 3 + 24 + 2.
    expect(await day('2026-10-20')).toMatchObject({ units_lost: 29, units_found: 0, net_units: -29 });
    // M4 at 00:00:00 (21:00:00 UTC on the 20th) is the 21st's, with the count and the settlement.
    expect(await day('2026-10-21')).toMatchObject({ units_lost: 4, units_found: 27, net_units: 23 });
    expect(await day('2026-10-22')).toMatchObject({ units_lost: 4, units_found: 0, net_units: -4 });
    expect(await day('2026-10-23')).toEqual({ units_lost: 0, units_found: 0, net_units: 0, value_lost_at_cost: '0.00', value_found_at_cost: '0.00', net_value_at_cost: '0.00', movements_without_cost: 0 });
    expect((await shrinkage('from=2026-10-23&to=2026-10-23', amina.token)).rows).toEqual([]);
    const all = await shrinkage('from=2026-08-01&to=2026-10-31&group_by=reason', amina.token);
    expect(all.totals).toMatchObject({ units_lost: 38, units_found: 27, net_units: -11 });
    expect(all.rows.find((r) => r.reason === 'DAMAGED')).toMatchObject({ units_lost: 8 });
  });

  // ---------------------------------------------------------------- 4. isolation and permissions
  it('4. identical data in two businesses never mixes; attendants are 403', async () => {
    const twins: { o: Member; loc: string; productId: string }[] = [];
    for (const name of ['Pacha E', 'Pacha F']) {
      const o = await api.signupOwner(name);
      const p = await product(o, 'Soda', [{ name: 'piece', units: 1, sell: '50.00', cost: '35.50' }]);
      const loc = await firstLocation(o);
      await accepted(o, 'stock.receive', { location_id: loc, lines: [{ pack_type_id: p.packIds[0], quantity: 10 }] }, '2026-10-24T08:00:00');
      await adjust(o, loc, p.packIds[0], name === 'Pacha E' ? -1 : -3, 'DAMAGED', '2026-10-24T09:00:00');
      twins.push({ o, loc, productId: p.productId });
    }
    const [e, f] = twins;
    expect((await stock('', e.o.token)).totals).toEqual({ pieces: 9, pools: 1, negative_pools: 0, value_at_cost: '319.50', pools_without_cost: 0 });
    expect((await stock('', f.o.token)).totals).toEqual({ pieces: 7, pools: 1, negative_pools: 0, value_at_cost: '248.50', pools_without_cost: 0 });
    expect((await shrinkage('from=2026-10-24&to=2026-10-24', e.o.token)).totals).toMatchObject({ units_lost: 1, value_lost_at_cost: '35.50' });
    expect((await shrinkage('from=2026-10-24&to=2026-10-24', f.o.token)).totals).toMatchObject({ units_lost: 3, value_lost_at_cost: '106.50' });
    // The other business's location as a filter finds nothing.
    expect((await stock(`location_id=${f.loc}`, e.o.token)).rows).toEqual([]);
    // The fixture's business sees neither.
    expect((await shrinkage('from=2026-10-24&to=2026-10-24', owner.token)).rows).toEqual([]);
    expect((await stock('', owner.token)).totals.pieces).toBe(409);

    for (const who of [baraka, otieno]) {
      expect(errorOf(await get('/v1/reports/stock', who.token))).toEqual({ status: 403, code: 'PERMISSION_DENIED' });
      expect(errorOf(await get('/v1/reports/shrinkage?from=2026-10-20&to=2026-10-21', who.token))).toEqual({ status: 403, code: 'PERMISSION_DENIED' });
    }
  });

  // ---------------------------------------------------------------- 5. parameter rules
  it('5. range, group_by and unknown parameters are checked', async () => {
    const refused = async (url: string) => errorOf(await get(url, wanjiru.token));
    expect(await refused('/v1/reports/shrinkage?from=2026-10-22&to=2026-10-21')).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(await refused('/v1/reports/shrinkage?from=2026-02-30&to=2026-03-01')).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(await refused('/v1/reports/shrinkage?to=2026-10-21')).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(await refused('/v1/reports/shrinkage?from=2026-07-31&to=2026-10-31')).toEqual({ status: 422, code: 'RANGE_TOO_LARGE' });
    expect(await refused('/v1/reports/shrinkage?from=2026-10-20&to=2026-10-21&group_by=day')).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(await refused(`/v1/reports/shrinkage?from=2026-10-20&to=2026-10-21&business_id=${owner.businessId}`)).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(await refused('/v1/reports/stock?group_by=reason')).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(await refused('/v1/reports/stock?include_zero=yes')).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(await refused('/v1/reports/stock?location_id=nope')).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(await refused('/v1/reports/stock?from=2026-10-20')).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(await refused(`/v1/reports/stock?business_id=${owner.businessId}`)).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect((await get('/v1/reports/shrinkage?from=2026-08-01&to=2026-10-31', wanjiru.token)).statusCode).toBe(200);
  });
});
