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
      INSERT INTO payment (business_id, sale_id, method, amount, mpesa_code, status, occurred_at, created_by_membership_id)
      VALUES (${currentBusinessId()}::uuid, ${p.saleId}::uuid, ${p.method}, ${p.amount}::numeric, ${p.mpesaCode},
              'RECORDED', ${p.occurredAt}, ${p.createdByMembershipId}::uuid)
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
      INSERT INTO payment (business_id, sale_id, method, amount, mpesa_code, duplicate_of_payment_id, status, occurred_at, created_by_membership_id)
      VALUES (${currentBusinessId()}::uuid, ${p.saleId}::uuid, ${p.method}, ${p.amount}::numeric, ${p.mpesaCode},
              ${originalId}::uuid, 'RECORDED', ${p.occurredAt}, ${p.createdByMembershipId}::uuid)`;
  }
}
