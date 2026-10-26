import type { PaymentReadRow } from '../payments/payments.repository.js';
import type { SaleItemReadRow, SaleReadRow } from './sales-reads.repository.js';

// How sales leave the API (docs/phase-e-design.md sections 7 and 8): the same
// shapes in the reads and in sync. snake_case, money as strings, times as UTC
// ISO text. cost_price is left out entirely (not null) without costs.view.

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Every column of a sale (the sync row, and the core of the detail read). */
export function saleJson(s: SaleReadRow): { id: string } & Record<string, Json> {
  return {
    id: s.id,
    sale_number: s.saleNumber,
    local_ref: s.localRef,
    location_id: s.locationId,
    device_id: s.deviceId,
    created_by_membership_id: s.createdByMembershipId,
    occurred_at: s.occurredAt.toISOString(),
    received_at: s.receivedAt.toISOString(),
    status: s.status,
    total: s.total,
    paid_total: s.paidTotal,
    balance_due: s.balanceDue,
    total_mismatch: s.totalMismatch,
    note: s.note,
    voided_at: iso(s.voidedAt),
    voided_by_membership_id: s.voidedByMembershipId,
    void_reason: s.voidReason,
    void_note: s.voidNote,
    void_approval_id: s.voidApprovalId,
    void_approved_by_membership_id: s.voidApprovedByMembershipId,
  };
}

/** One row of GET /v1/sales. */
export function saleListJson(s: SaleReadRow & { itemCount: number }, names: ReadonlyMap<string, string>) {
  return {
    id: s.id,
    sale_number: s.saleNumber,
    local_ref: s.localRef,
    location_id: s.locationId,
    occurred_at: s.occurredAt.toISOString(),
    status: s.status,
    total: s.total,
    paid_total: s.paidTotal,
    balance_due: s.balanceDue,
    created_by: person(s.createdByMembershipId, names),
    item_count: s.itemCount,
  };
}

export function saleItemJson(i: SaleItemReadRow, canSeeCosts: boolean): { id: string } & Record<string, Json> {
  return {
    id: i.id,
    sale_id: i.saleId,
    line_no: i.lineNo,
    pack_type_id: i.packTypeId,
    product_name: i.productName,
    pack_type_name: i.packTypeName,
    quantity: i.quantity,
    unit_price: i.unitPrice,
    list_price: i.listPrice,
    ...(canSeeCosts ? { cost_price: i.costPrice } : {}),
    line_total: i.lineTotal,
  };
}

export function paymentJson(p: PaymentReadRow): { id: string } & Record<string, Json> {
  return {
    id: p.id,
    sale_id: p.saleId,
    method: p.method,
    amount: p.amount,
    mpesa_code: p.mpesaCode,
    verified: p.verified,
    duplicate: p.duplicate,
    status: p.status,
    occurred_at: p.occurredAt.toISOString(),
  };
}

/** A member as { membership_id, display_name }, or null. */
export function person(membershipId: string | null, names: ReadonlyMap<string, string>) {
  return membershipId === null ? null : { membership_id: membershipId, display_name: names.get(membershipId) ?? null };
}
