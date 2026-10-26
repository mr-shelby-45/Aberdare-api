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

  async insertItems(saleId: string, items: SaleItemRow[]): Promise<void> {
    await currentTx().saleItem.createMany({
      data: items.map((i) => ({ businessId: currentBusinessId(), saleId, ...i })),
    });
  }
}
