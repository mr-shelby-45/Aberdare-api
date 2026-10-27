import { Injectable } from '@nestjs/common';
import { FieldSettlementsRepository, type SettlementInsert, type SettlementLineRow } from './field-settlements.repository.js';

// Field settlements (Phase T4): the data module for field_settlement and its
// lines. It imports no feature module, so both the sales module (the
// AFTER_SETTLEMENT flag) and the field module (preview, close, reads) can use it.
@Injectable()
export class FieldSettlementsService {
  constructor(private readonly repo: FieldSettlementsRepository) {}

  async exists(id: string): Promise<boolean> {
    return this.repo.exists(id);
  }

  /** The location's latest settlement (period_end, snapshot), or null. */
  async latest(fieldLocationId: string) {
    return this.repo.latest(fieldLocationId);
  }

  async currentSnapshot(): Promise<string> {
    return this.repo.currentSnapshot();
  }

  /** The settlement row; its lines follow once the counts are applied (the adjustments need the row). */
  async insert(settlement: SettlementInsert): Promise<void> {
    await this.repo.insert(settlement);
  }

  async insertLines(settlementId: string, lines: SettlementLineRow[]): Promise<void> {
    await this.repo.insertLines(settlementId, lines);
  }

  async list(f: { locationId: string | null; after: { periodEndKey: string; id: string } | null; limit: number }) {
    return this.repo.list(f);
  }

  async byId(id: string) {
    return this.repo.byId(id);
  }
}
