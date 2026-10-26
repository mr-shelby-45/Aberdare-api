import { Injectable } from '@nestjs/common';
import { StockRepository } from './stock.repository.js';

export interface IntegrityMismatch {
  locationId: string;
  packTypeId: string;
  // null: no balance row exists for this pool.
  balance: number | null;
  // null: no movement exists for this pool.
  ledgerSum: number | null;
}

// The ledger check (docs/phase-c-design.md section 3): the cached balance must
// always equal the sum of its movements. Runs inside a tenant transaction and
// sees only that business. A service only: no endpoint; Phase F schedules it
// per business and decides what to do with a mismatch.
@Injectable()
export class StockIntegrityService {
  constructor(private readonly repo: StockRepository) {}

  /** Every mismatching pool; an empty list means the ledger and balances agree. */
  async check(): Promise<IntegrityMismatch[]> {
    const rows = await this.repo.integrityMismatches();
    return rows.map((r) => ({
      locationId: r.locationId,
      packTypeId: r.packTypeId,
      // Quantities are integers far below 2^53, so these conversions are exact.
      balance: r.balance === null ? null : Number(r.balance),
      ledgerSum: r.ledgerSum === null ? null : Number(r.ledgerSum),
    }));
  }
}
