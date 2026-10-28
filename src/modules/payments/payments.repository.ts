import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';

export interface PaymentRow {
  saleId: string;
  method: 'CASH' | 'MPESA';
  // Money as canonical text ("99.99"), never a number.
  amount: string;
  mpesaCode: string | null;
  occurredAt: Date;
  createdByMembershipId: string;
  // Phase T6: the sale's location and the device the payment was recorded on.
  locationId: string;
  recordedByDeviceId: string;
}

/** The cash and M-Pesa a field settlement expects (Phase T6). Money as canonical text, possibly negative. */
export interface WindowPaymentTotals {
  cash: string;
  mpesaVerified: string;
  mpesaUnverified: string;
  // The part of cash that belongs to sales outside the window (late payments and late refunds).
  earlierSalesCash: string;
}

/** Whose payments a field settlement counts: the attendant's own, on their personal devices. */
export interface WindowPayer {
  membershipId: string;
  deviceIds: string[];
}

/** A payment as reads and sync show it (Phase E4). Money as canonical text. */
export interface PaymentReadRow {
  id: string;
  saleId: string;
  method: string;
  amount: string;
  mpesaCode: string | null;
  verified: boolean;
  duplicate: boolean;
  status: string;
  occurredAt: Date;
}

interface RawPayment {
  id: string;
  sale_id: string;
  method: string;
  amount: string;
  mpesa_code: string | null;
  verified: boolean;
  duplicate: boolean;
  status: string;
  occurred_at: Date;
}

function readRows(rows: RawPayment[]): PaymentReadRow[] {
  return rows.map((r) => ({
    id: r.id,
    saleId: r.sale_id,
    method: r.method,
    amount: r.amount,
    mpesaCode: r.mpesa_code,
    verified: r.verified,
    duplicate: r.duplicate,
    status: r.status,
    occurredAt: r.occurred_at,
  }));
}

// payment SQL (Phase E3), on the current tenant transaction. app_user may
// insert payments and change only their status (a void, E5); never delete.
@Injectable()
export class PaymentsRepository {
  /**
   * Inserts the payment as an original, or returns null when this business
   * already has an original payment with this M-Pesa code. One statement on
   * the partial unique index payment_mpesa_code_unique: a concurrent command
   * holding the same code makes this wait for its commit, then do nothing, so
   * two originals can never exist and nothing fails (never check, then insert).
   */
  async insertOriginal(p: PaymentRow): Promise<string | null> {
    const rows = await currentTx().$queryRaw<{ id: string }[]>`
      INSERT INTO payment (business_id, sale_id, method, amount, mpesa_code, status, occurred_at, created_by_membership_id, location_id, recorded_by_device_id)
      VALUES (${currentBusinessId()}::uuid, ${p.saleId}::uuid, ${p.method}, ${p.amount}::numeric, ${p.mpesaCode},
              'RECORDED', ${p.occurredAt}, ${p.createdByMembershipId}::uuid, ${p.locationId}::uuid, ${p.recordedByDeviceId}::uuid)
      ON CONFLICT (business_id, mpesa_code) WHERE mpesa_code IS NOT NULL AND duplicate_of_payment_id IS NULL
      DO NOTHING
      RETURNING id`;
    return rows[0]?.id ?? null;
  }

  /** The original payment of this code (it exists once insertOriginal() returned null; payments are never deleted). */
  async originalOf(mpesaCode: string): Promise<string | null> {
    const rows = await currentTx().$queryRaw<{ id: string }[]>`
      SELECT id FROM payment
       WHERE business_id = ${currentBusinessId()}::uuid AND mpesa_code = ${mpesaCode}
         AND duplicate_of_payment_id IS NULL`;
    return rows[0]?.id ?? null;
  }

  /**
   * Phase E5, sale.void: every RECORDED payment of the sale becomes REVERSED
   * (its code stays used). Phase T6: in the same statement, reversed_txid
   * records the transaction, so settlements count the refund in their window.
   */
  async reverseForSale(saleId: string): Promise<number> {
    return currentTx().$executeRaw`
      UPDATE payment SET status = 'REVERSED', reversed_txid = pg_current_xact_id()
       WHERE business_id = ${currentBusinessId()}::uuid AND sale_id = ${saleId}::uuid AND status = 'RECORDED'`;
  }

  /**
   * Phase T6: the payments a field settlement expects, by the snapshot rule.
   * A payment counts in (+) in the settlement whose snapshot first sees its
   * txid, and its reversal out (-) in the one that first sees reversed_txid;
   * both in one window cancel out. Only the attendant's own payments on their
   * personal devices count (payer). Sums by method, M-Pesa verified or not, and
   * the cash of sales outside the window (windowSaleIds). Never the status now.
   */
  async windowTotals(locationId: string, payer: WindowPayer, snapshot: string, previous: string | null, windowSaleIds: string[]): Promise<WindowPaymentTotals> {
    const rows = await currentTx().$queryRaw<{ cash: string; mpesa_verified: string; mpesa_unverified: string; earlier_cash: string }[]>`
      WITH w AS (
        SELECT p.method, p.verified, p.sale_id,
               (CASE WHEN pg_visible_in_snapshot(p.txid, ${snapshot}::pg_snapshot)
                      AND (${previous}::text IS NULL OR NOT pg_visible_in_snapshot(p.txid, ${previous}::pg_snapshot))
                     THEN p.amount ELSE 0 END)
             - (CASE WHEN p.reversed_txid IS NOT NULL AND pg_visible_in_snapshot(p.reversed_txid, ${snapshot}::pg_snapshot)
                      AND (${previous}::text IS NULL OR NOT pg_visible_in_snapshot(p.reversed_txid, ${previous}::pg_snapshot))
                     THEN p.amount ELSE 0 END) AS net
          FROM payment p
         WHERE p.business_id = ${currentBusinessId()}::uuid AND p.location_id = ${locationId}::uuid
           AND p.created_by_membership_id = ${payer.membershipId}::uuid
           AND p.recorded_by_device_id = ANY(${payer.deviceIds}::uuid[]))
      SELECT coalesce(sum(net) FILTER (WHERE method = 'CASH'), 0)::numeric(14,2)::text AS cash,
             coalesce(sum(net) FILTER (WHERE method = 'MPESA' AND verified), 0)::numeric(14,2)::text AS mpesa_verified,
             coalesce(sum(net) FILTER (WHERE method = 'MPESA' AND NOT verified), 0)::numeric(14,2)::text AS mpesa_unverified,
             coalesce(sum(net) FILTER (WHERE method = 'CASH' AND sale_id <> ALL(${windowSaleIds}::uuid[])), 0)::numeric(14,2)::text AS earlier_cash
        FROM w`;
    const r = rows[0];
    return { cash: r.cash, mpesaVerified: r.mpesa_verified, mpesaUnverified: r.mpesa_unverified, earlierSalesCash: r.earlier_cash };
  }

  /** Payments of these sales (Phase E4 reads). */
  async forSales(saleIds: string[]): Promise<PaymentReadRow[]> {
    if (saleIds.length === 0) return [];
    return readRows(
      await currentTx().$queryRaw<RawPayment[]>`
        SELECT id, sale_id, method, amount::text AS amount, mpesa_code, verified,
               (duplicate_of_payment_id IS NOT NULL) AS duplicate, status, occurred_at FROM payment
         WHERE business_id = ${currentBusinessId()}::uuid AND sale_id = ANY(${saleIds}::uuid[])
         ORDER BY created_at, id`,
    );
  }

  /** These payments as they are now; missing ids are absent (Phase E4 changes). */
  async byIds(ids: string[]): Promise<PaymentReadRow[]> {
    if (ids.length === 0) return [];
    return readRows(
      await currentTx().$queryRaw<RawPayment[]>`
        SELECT id, sale_id, method, amount::text AS amount, mpesa_code, verified,
               (duplicate_of_payment_id IS NOT NULL) AS duplicate, status, occurred_at FROM payment
         WHERE business_id = ${currentBusinessId()}::uuid AND id = ANY(${ids}::uuid[])`,
    );
  }

  /** Payments of these sales after afterId in id order (Phase E4 snapshot). */
  async pageForSync(afterId: string | null, limit: number, saleIds: string[]): Promise<PaymentReadRow[]> {
    if (saleIds.length === 0) return [];
    return readRows(
      await currentTx().$queryRaw<RawPayment[]>`
        SELECT id, sale_id, method, amount::text AS amount, mpesa_code, verified,
               (duplicate_of_payment_id IS NOT NULL) AS duplicate, status, occurred_at FROM payment
         WHERE business_id = ${currentBusinessId()}::uuid AND sale_id = ANY(${saleIds}::uuid[])
           AND (${afterId}::uuid IS NULL OR id > ${afterId}::uuid)
         ORDER BY id
         LIMIT ${limit}::int`,
    );
  }

  /** A payment whose code was already used: saved, pointing at the original, outside the unique index. */
  async insertDuplicate(p: PaymentRow, originalId: string): Promise<void> {
    await currentTx().$executeRaw`
      INSERT INTO payment (business_id, sale_id, method, amount, mpesa_code, duplicate_of_payment_id, status, occurred_at, created_by_membership_id, location_id, recorded_by_device_id)
      VALUES (${currentBusinessId()}::uuid, ${p.saleId}::uuid, ${p.method}, ${p.amount}::numeric, ${p.mpesaCode},
              ${originalId}::uuid, 'RECORDED', ${p.occurredAt}, ${p.createdByMembershipId}::uuid, ${p.locationId}::uuid, ${p.recordedByDeviceId}::uuid)`;
  }
}
