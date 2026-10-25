import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';

// product_barcode SQL, on the current tenant transaction. The only catalogue
// table with DELETE (barcode.remove, Phase B3).
@Injectable()
export class BarcodesRepository {
  /** The code must already be normalised. A taken code is a unique violation. */
  async insert(barcode: { barcode: string; productId: string; packTypeId: string; createdByMembershipId: string }): Promise<void> {
    await currentTx().productBarcode.create({
      data: { businessId: currentBusinessId(), ...barcode },
      select: { id: true },
    });
  }
}
