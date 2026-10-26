import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';

/** A sale as reads and sync show it (Phase E4). Money as canonical text. */
export interface SaleReadRow {
  id: string;
  saleNumber: number;
  localRef: string;
  locationId: string;
  deviceId: string;
  createdByMembershipId: string;
  occurredAt: Date;
  // occurred_at as Postgres text (microseconds kept), for the list cursor.
  occurredKey: string;
  receivedAt: Date;
  status: string;
  total: string;
  paidTotal: string;
  balanceDue: string;
  totalMismatch: boolean;
  note: string | null;
  voidedAt: Date | null;
  voidedByMembershipId: string | null;
  voidReason: string | null;
  voidNote: string | null;
  voidApprovalId: string | null;
  voidApprovedByMembershipId: string | null;
}

export interface SaleItemReadRow {
  id: string;
  saleId: string;
  lineNo: number;
  packTypeId: string;
  productName: string;
  packTypeName: string;
  quantity: number;
  unitPrice: string;
  listPrice: string;
  costPrice: string | null;
  lineTotal: string;
}

export interface SaleListFilters {
  // Only this member's sales (a reader without sales.void, or the created_by filter).
  createdBy: string | null;
  locationId: string | null;
  status: string | null;
  from: string | null;
  to: string | null;
  after: { occurredKey: string; id: string } | null;
  limit: number;
}

interface RawSale {
  id: string;
  sale_number: number;
  local_ref: string;
  location_id: string;
  device_id: string;
  created_by_membership_id: string;
  occurred_at: Date;
  occurred_key: string;
  received_at: Date;
  status: string;
  total: string;
  paid_total: string;
  balance_due: string;
  total_mismatch: boolean;
  note: string | null;
  voided_at: Date | null;
  voided_by_membership_id: string | null;
  void_reason: string | null;
  void_note: string | null;
  void_approval_id: string | null;
  void_approved_by_membership_id: string | null;
}

interface RawItem {
  id: string;
  sale_id: string;
  line_no: number;
  pack_type_id: string;
  product_name: string;
  pack_type_name: string;
  quantity: number;
  unit_price: string;
  list_price: string;
  cost_price: string | null;
  line_total: string;
}

// Read-only sale and sale_item SQL (Phase E4), on the current tenant
// transaction. Only this module's own tables. "createdBy" restricts rows to
// one member's sales: the visibility rule of docs/phase-e-design.md section 7,
// decided by SalesReadsService. Prices and totals as numeric::text.
@Injectable()
export class SalesReadsRepository {
  /** Newest first by (occurred_at, id), with each sale's item count. */
  async list(f: SaleListFilters): Promise<(SaleReadRow & { itemCount: number })[]> {
    const rows = await currentTx().$queryRaw<(RawSale & { item_count: number })[]>`
      SELECT s.id, s.sale_number, s.local_ref, s.location_id, s.device_id, s.created_by_membership_id,
             s.occurred_at, s.occurred_at::text AS occurred_key, s.received_at, s.status,
             s.total::text AS total, s.paid_total::text AS paid_total, s.balance_due::text AS balance_due,
             s.total_mismatch, s.note, s.voided_at, s.voided_by_membership_id, s.void_reason, s.void_note,
             s.void_approval_id, s.void_approved_by_membership_id,
             (SELECT count(*)::int FROM sale_item i WHERE i.business_id = s.business_id AND i.sale_id = s.id) AS item_count
        FROM sale s
       WHERE s.business_id = ${currentBusinessId()}::uuid
         AND (${f.createdBy}::uuid IS NULL OR s.created_by_membership_id = ${f.createdBy}::uuid)
         AND (${f.locationId}::uuid IS NULL OR s.location_id = ${f.locationId}::uuid)
         AND (${f.status}::text IS NULL OR s.status = ${f.status}::text)
         AND (${f.from}::timestamptz IS NULL OR s.occurred_at >= ${f.from}::timestamptz)
         AND (${f.to}::timestamptz IS NULL OR s.occurred_at < ${f.to}::timestamptz)
         AND (${f.after?.occurredKey ?? null}::timestamptz IS NULL
              OR (s.occurred_at, s.id) < (${f.after?.occurredKey ?? null}::timestamptz, ${f.after?.id ?? null}::uuid))
       ORDER BY s.occurred_at DESC, s.id DESC
       LIMIT ${f.limit}::int`;
    return rows.map((r) => ({ ...saleRow(r), itemCount: r.item_count }));
  }

  /** These sales (only createdBy's when given); missing or hidden ids are absent. */
  async byIds(ids: string[], createdBy: string | null): Promise<SaleReadRow[]> {
    if (ids.length === 0) return [];
    const rows = await currentTx().$queryRaw<RawSale[]>`
      SELECT s.id, s.sale_number, s.local_ref, s.location_id, s.device_id, s.created_by_membership_id,
             s.occurred_at, s.occurred_at::text AS occurred_key, s.received_at, s.status,
             s.total::text AS total, s.paid_total::text AS paid_total, s.balance_due::text AS balance_due,
             s.total_mismatch, s.note, s.voided_at, s.voided_by_membership_id, s.void_reason, s.void_note,
             s.void_approval_id, s.void_approved_by_membership_id
        FROM sale s
       WHERE s.business_id = ${currentBusinessId()}::uuid AND s.id = ANY(${ids}::uuid[])
         AND (${createdBy}::uuid IS NULL OR s.created_by_membership_id = ${createdBy}::uuid)`;
    return rows.map(saleRow);
  }

  /** Sales with occurred_at at or after since, after afterId in id order (snapshot). */
  async pageForSync(afterId: string | null, limit: number, since: Date, createdBy: string | null): Promise<SaleReadRow[]> {
    const rows = await currentTx().$queryRaw<RawSale[]>`
      SELECT s.id, s.sale_number, s.local_ref, s.location_id, s.device_id, s.created_by_membership_id,
             s.occurred_at, s.occurred_at::text AS occurred_key, s.received_at, s.status,
             s.total::text AS total, s.paid_total::text AS paid_total, s.balance_due::text AS balance_due,
             s.total_mismatch, s.note, s.voided_at, s.voided_by_membership_id, s.void_reason, s.void_note,
             s.void_approval_id, s.void_approved_by_membership_id
        FROM sale s
       WHERE s.business_id = ${currentBusinessId()}::uuid
         AND s.occurred_at >= ${since}
         AND (${createdBy}::uuid IS NULL OR s.created_by_membership_id = ${createdBy}::uuid)
         AND (${afterId}::uuid IS NULL OR s.id > ${afterId}::uuid)
       ORDER BY s.id
       LIMIT ${limit}::int`;
    return rows.map(saleRow);
  }

  /** Ids of the sales with occurred_at at or after since (only createdBy's when given). */
  async idsSince(since: Date, createdBy: string | null): Promise<string[]> {
    const rows = await currentTx().$queryRaw<{ id: string }[]>`
      SELECT s.id FROM sale s
       WHERE s.business_id = ${currentBusinessId()}::uuid
         AND s.occurred_at >= ${since}
         AND (${createdBy}::uuid IS NULL OR s.created_by_membership_id = ${createdBy}::uuid)`;
    return rows.map((r) => r.id);
  }

  /** Which of these sales createdBy may see (all of them when null). */
  async visibleIds(ids: string[], createdBy: string | null): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await currentTx().$queryRaw<{ id: string }[]>`
      SELECT s.id FROM sale s
       WHERE s.business_id = ${currentBusinessId()}::uuid AND s.id = ANY(${ids}::uuid[])
         AND (${createdBy}::uuid IS NULL OR s.created_by_membership_id = ${createdBy}::uuid)`;
    return new Set(rows.map((r) => r.id));
  }

  /** Items of these sales, in line order. */
  async items(saleIds: string[]): Promise<SaleItemReadRow[]> {
    if (saleIds.length === 0) return [];
    const rows = await currentTx().$queryRaw<RawItem[]>`
      SELECT i.id, i.sale_id, i.line_no, i.pack_type_id, i.product_name, i.pack_type_name, i.quantity,
             i.unit_price::text AS unit_price, i.list_price::text AS list_price,
             i.cost_price::text AS cost_price, i.line_total::text AS line_total
        FROM sale_item i
       WHERE i.business_id = ${currentBusinessId()}::uuid AND i.sale_id = ANY(${saleIds}::uuid[])
       ORDER BY i.sale_id, i.line_no`;
    return rows.map(itemRow);
  }

  /** These items, only those of sales createdBy may see; missing or hidden ids are absent (changes). */
  async itemsByIds(ids: string[], createdBy: string | null): Promise<SaleItemReadRow[]> {
    if (ids.length === 0) return [];
    const rows = await currentTx().$queryRaw<RawItem[]>`
      SELECT i.id, i.sale_id, i.line_no, i.pack_type_id, i.product_name, i.pack_type_name, i.quantity,
             i.unit_price::text AS unit_price, i.list_price::text AS list_price,
             i.cost_price::text AS cost_price, i.line_total::text AS line_total
        FROM sale_item i
        JOIN sale s ON s.business_id = i.business_id AND s.id = i.sale_id
       WHERE i.business_id = ${currentBusinessId()}::uuid AND i.id = ANY(${ids}::uuid[])
         AND (${createdBy}::uuid IS NULL OR s.created_by_membership_id = ${createdBy}::uuid)`;
    return rows.map(itemRow);
  }

  /** Items of sales with occurred_at at or after since, after afterId in id order (snapshot). */
  async itemsPageForSync(afterId: string | null, limit: number, since: Date, createdBy: string | null): Promise<SaleItemReadRow[]> {
    const rows = await currentTx().$queryRaw<RawItem[]>`
      SELECT i.id, i.sale_id, i.line_no, i.pack_type_id, i.product_name, i.pack_type_name, i.quantity,
             i.unit_price::text AS unit_price, i.list_price::text AS list_price,
             i.cost_price::text AS cost_price, i.line_total::text AS line_total
        FROM sale_item i
        JOIN sale s ON s.business_id = i.business_id AND s.id = i.sale_id
       WHERE i.business_id = ${currentBusinessId()}::uuid
         AND s.occurred_at >= ${since}
         AND (${createdBy}::uuid IS NULL OR s.created_by_membership_id = ${createdBy}::uuid)
         AND (${afterId}::uuid IS NULL OR i.id > ${afterId}::uuid)
       ORDER BY i.id
       LIMIT ${limit}::int`;
    return rows.map(itemRow);
  }
}

function saleRow(r: RawSale): SaleReadRow {
  return {
    id: r.id,
    saleNumber: r.sale_number,
    localRef: r.local_ref,
    locationId: r.location_id,
    deviceId: r.device_id,
    createdByMembershipId: r.created_by_membership_id,
    occurredAt: r.occurred_at,
    occurredKey: r.occurred_key,
    receivedAt: r.received_at,
    status: r.status,
    total: r.total,
    paidTotal: r.paid_total,
    balanceDue: r.balance_due,
    totalMismatch: r.total_mismatch,
    note: r.note,
    voidedAt: r.voided_at,
    voidedByMembershipId: r.voided_by_membership_id,
    voidReason: r.void_reason,
    voidNote: r.void_note,
    voidApprovalId: r.void_approval_id,
    voidApprovedByMembershipId: r.void_approved_by_membership_id,
  };
}

function itemRow(r: RawItem): SaleItemReadRow {
  return {
    id: r.id,
    saleId: r.sale_id,
    lineNo: r.line_no,
    packTypeId: r.pack_type_id,
    productName: r.product_name,
    packTypeName: r.pack_type_name,
    quantity: r.quantity,
    unitPrice: r.unit_price,
    listPrice: r.list_price,
    costPrice: r.cost_price,
    lineTotal: r.line_total,
  };
}
