import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';

/**
 * A position in one business's change log: after this (txid, id), in that
 * order. Both are 64-bit numbers, kept as decimal text so they never pass
 * through a JavaScript number.
 */
export interface ChangePosition {
  txid: string;
  id: string;
}

export interface ChangeLogRow {
  id: string;
  txid: string;
  tableName: string;
  rowId: string;
  // A barcode's text (Phase B); null for other tables.
  rowKey: string | null;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
}

// change_log reads for GET /v1/sync/snapshot and /changes (Phase D,
// docs/phase-d-design.md section 4). Every method runs on the current tenant
// transaction, so RLS limits it to the caller's business; the business_id
// filters are in addition to RLS, never instead of it.
@Injectable()
export class ChangeLogRepository {
  /**
   * Where a new reader starts: every transaction with an id below
   * pg_snapshot_xmin has finished, so (xmin, 0) means "everything finished
   * so far is before me". Rows of transactions at or above xmin come later
   * through changes (some may also be in a snapshot read afterwards; the
   * phone applies each record's current state, so twice is harmless).
   */
  async startPosition(): Promise<ChangePosition> {
    const rows = await currentTx().$queryRaw<{ txid: string }[]>`
      SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS txid`;
    return { txid: rows[0].txid, id: '0' };
  }

  /**
   * The finished-transactions query (approved by Ian in D1). Rows come in
   * (txid, id) order, and only from transactions below pg_snapshot_xmin.
   * Why this removes the gap problem: change_log ids are handed out when a
   * row is written, not when its transaction commits, so a reader that went
   * by id alone could pass a row whose transaction commits later and never
   * see it. Here every transaction below xmin has already finished
   * (committed or rolled back), and any transaction that writes later gets a
   * higher transaction id than xmin. So once a position is returned, no row
   * can ever appear behind it. Rows of a transaction still open (or that
   * started before another open one) simply wait until it is safe.
   * Never order by id alone or by changed_at (one transaction shares it).
   */
  async finishedAfter(after: ChangePosition, limit: number): Promise<ChangeLogRow[]> {
    const rows = await currentTx().$queryRaw<
      { id: string; txid: string; table_name: string; row_id: string; row_key: string | null; operation: 'INSERT' | 'UPDATE' | 'DELETE' }[]
    >`
      SELECT id::text AS id, txid::text AS txid, table_name, row_id, row_key, operation
        FROM change_log
       WHERE business_id = ${currentBusinessId()}::uuid
         AND txid < pg_snapshot_xmin(pg_current_snapshot())
         AND (txid, id) > (${after.txid}::xid8, ${after.id}::bigint)
       ORDER BY txid, id
       LIMIT ${limit}::int`;
    return rows.map((r) => ({ id: r.id, txid: r.txid, tableName: r.table_name, rowId: r.row_id, rowKey: r.row_key, operation: r.operation }));
  }

  /**
   * Whether every change_log row after this position is still kept: the
   * position is at or after the newest one the prune removed
   * (change_log_horizon, migration *_d1_change_log_prune).
   */
  async isRetained(position: ChangePosition): Promise<boolean> {
    const rows = await currentTx().$queryRaw<{ retained: boolean }[]>`
      SELECT (${position.txid}::xid8, ${position.id}::bigint) >= (pruned_through_txid, pruned_through_id) AS retained
        FROM change_log_horizon
       WHERE id = 1`;
    return rows[0]?.retained === true;
  }
}
