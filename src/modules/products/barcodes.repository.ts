import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';

export interface BarcodeRow {
  barcode: string;
  productId: string;
  packTypeId: string;
}

// product_barcode SQL, on the current tenant transaction. The only catalogue
// table with DELETE (barcode.remove). Every code must already be normalised.
@Injectable()
export class BarcodesRepository {
  /** product.create: a taken code is a unique violation (mapped to BARCODE_TAKEN). */
  async insert(barcode: { barcode: string; productId: string; packTypeId: string; createdByMembershipId: string }): Promise<void> {
    await currentTx().productBarcode.create({
      data: { businessId: currentBusinessId(), ...barcode },
      select: { id: true },
    });
  }

  /**
   * barcode.add: inserts unless the code is taken in this business. True when
   * this call stored it. A concurrent insert of the same code waits on the
   * unique index and then reports false (never check-then-insert).
   */
  async insertIfAbsent(barcode: { barcode: string; productId: string; packTypeId: string; createdByMembershipId: string }): Promise<boolean> {
    const rows = await currentTx().$queryRaw<{ id: string }[]>`
      INSERT INTO product_barcode (business_id, barcode, product_id, pack_type_id, created_by_membership_id)
      VALUES (${currentBusinessId()}::uuid, ${barcode.barcode}, ${barcode.productId}::uuid,
              ${barcode.packTypeId}::uuid, ${barcode.createdByMembershipId}::uuid)
      ON CONFLICT (business_id, barcode) DO NOTHING
      RETURNING id`;
    return rows.length === 1;
  }

  async findByCode(barcode: string): Promise<BarcodeRow | null> {
    return currentTx().productBarcode.findUnique({
      where: { businessId_barcode: { businessId: currentBusinessId(), barcode } },
      select: { barcode: true, productId: true, packTypeId: true },
    });
  }

  /** barcode.remove: the deleted row, or null when the code was not there. */
  async remove(barcode: string): Promise<BarcodeRow | null> {
    const rows = await currentTx().$queryRaw<{ barcode: string; product_id: string; pack_type_id: string }[]>`
      DELETE FROM product_barcode
       WHERE business_id = ${currentBusinessId()}::uuid AND barcode = ${barcode}
      RETURNING barcode, product_id, pack_type_id`;
    const r = rows[0];
    return r ? { barcode: r.barcode, productId: r.product_id, packTypeId: r.pack_type_id } : null;
  }

  async listForProducts(productIds: string[]): Promise<BarcodeRow[]> {
    if (productIds.length === 0) return [];
    return currentTx().productBarcode.findMany({
      where: { productId: { in: productIds } },
      orderBy: { barcode: 'asc' },
      select: { barcode: true, productId: true, packTypeId: true },
    });
  }

  /** Phase D2 snapshot: every barcode, keyset by id. */
  async pageForSync(afterId: string | null, limit: number): Promise<(BarcodeRow & { id: string })[]> {
    return currentTx().productBarcode.findMany({
      where: afterId ? { id: { gt: afterId } } : {},
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true, barcode: true, productId: true, packTypeId: true },
    });
  }
}
