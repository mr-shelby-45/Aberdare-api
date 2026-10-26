import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';

export interface SaleRow {
  id: string;
  saleNumber: number;
  localRef: string;
  locationId: string;
  deviceId: string;
  createdByMembershipId: string;
  occurredAt: Date;
  receivedAt: Date;
  // Money as canonical text ("99.99"), never a number.
  total: string;
  paidTotal: string;
  balanceDue: string;
  totalMismatch: boolean;
  note: string | null;
}

export interface SaleItemRow {
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

// sale, sale_item and sale_counter SQL (Phase E), on the current tenant
// transaction. app_user cannot delete any of these rows (Phase E1).
@Injectable()
export class SalesRepository {
  /** Whether this business already has a sale with this id. */
  async exists(saleId: string): Promise<boolean> {
    return (await currentTx().sale.findUnique({ where: { id: saleId }, select: { id: true } })) !== null;
  }

  /**
   * The business's next sale_number, in one atomic statement: the first sale
   * inserts the counter row, later ones increment it. Concurrent sales wait
   * for the row lock, so each gets its own number; a rolled-back command
   * rolls the increment back too, so there is never a gap. Called after the
   * stock statements (docs/phase-e-design.md section 4).
   */
  async nextSaleNumber(): Promise<number> {
    const rows = await currentTx().$queryRaw<{ last_number: number }[]>`
      INSERT INTO sale_counter (business_id, last_number)
      VALUES (${currentBusinessId()}::uuid, 1)
      ON CONFLICT (business_id) DO UPDATE SET last_number = sale_counter.last_number + 1
      RETURNING last_number`;
    return rows[0].last_number;
  }

  async insertSale(sale: SaleRow): Promise<void> {
    await currentTx().sale.create({
      data: { businessId: currentBusinessId(), status: 'COMPLETED', ...sale },
      select: { id: true },
    });
  }

  /** Who created the sale, its status, number and location, or null when this business has no such sale. */
  async findState(saleId: string): Promise<{ createdByMembershipId: string; status: string; saleNumber: number; locationId: string } | null> {
    return currentTx().sale.findUnique({ where: { id: saleId }, select: { createdByMembershipId: true, status: true, saleNumber: true, locationId: true } });
  }

  /**
   * Phase E5, sale.void: one conditional statement. Only a COMPLETED sale
   * matches (and the voided_is_final policy makes a VOIDED one match nothing
   * as well), so of any number of concurrent voids exactly one changes the row;
   * the others wait for its row lock and then match nothing. False when
   * nothing changed.
   */
  async markVoided(
    saleId: string,
    v: { voidedAt: Date; voidedByMembershipId: string; reason: string; note: string | null; approvalId: string | null; approvedByMembershipId: string },
  ): Promise<boolean> {
    const changed = await currentTx().$executeRaw`
      UPDATE sale
         SET status = 'VOIDED', voided_at = ${v.voidedAt}, voided_by_membership_id = ${v.voidedByMembershipId}::uuid,
             void_reason = ${v.reason}, void_note = ${v.note}, void_approval_id = ${v.approvalId}::uuid,
             void_approved_by_membership_id = ${v.approvedByMembershipId}::uuid
       WHERE id = ${saleId}::uuid AND business_id = ${currentBusinessId()}::uuid AND status = 'COMPLETED'`;
    return changed === 1;
  }

  /** The sale's lines: what a void puts back. */
  async lines(saleId: string): Promise<{ packTypeId: string; quantity: number }[]> {
    return currentTx().saleItem.findMany({ where: { saleId }, orderBy: { lineNo: 'asc' }, select: { packTypeId: true, quantity: true } });
  }

  /**
   * Adds an amount to a completed sale's paid_total and recomputes its
   * balance_due, in one conditional statement: it takes the sale's row lock,
   * so concurrent attaches add up exactly and a concurrent void (E5) is
   * ordered before or after it. Null when the sale is not COMPLETED any more
   * (the voided_is_final policy also makes a voided sale match nothing).
   */
  async addPaid(saleId: string, amount: string): Promise<{ total: string; paidTotal: string; balanceDue: string } | null> {
    const rows = await currentTx().$queryRaw<{ total: string; paid_total: string; balance_due: string }[]>`
      UPDATE sale
         SET paid_total = paid_total + ${amount}::numeric,
             balance_due = GREATEST(total - (paid_total + ${amount}::numeric), 0)
       WHERE id = ${saleId}::uuid AND business_id = ${currentBusinessId()}::uuid AND status = 'COMPLETED'
      RETURNING total::text, paid_total::text, balance_due::text`;
    const r = rows[0];
    return r ? { total: r.total, paidTotal: r.paid_total, balanceDue: r.balance_due } : null;
  }

  async insertItems(saleId: string, items: SaleItemRow[]): Promise<void> {
    await currentTx().saleItem.createMany({
      data: items.map((i) => ({ businessId: currentBusinessId(), saleId, ...i })),
    });
  }
}
