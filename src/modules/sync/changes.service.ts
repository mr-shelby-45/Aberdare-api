import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api.error.js';
import { DevicesService } from '../devices/devices.service.js';
import { ChangeFeedService } from './change-feed.service.js';
import type { ChangeLogRow, ChangePosition } from './change-log.repository.js';
import type { ChangesQueryDto } from './dto/changes-query.dto.js';
import { type SyncReader, syncView } from './snapshot.service.js';
import { type SyncRow, type SyncTableName, SyncTables } from './sync-tables.js';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export interface SyncChange {
  table: SyncTableName;
  op: 'upsert' | 'delete';
  id: string;
  // upsert: the record as it is now.
  row?: SyncRow;
  // delete of a barcode: its text, so a phone that knows it only by code can remove it.
  key?: { barcode: string | null };
}

// GET /v1/sync/changes (docs/phase-d-design.md section 6). One request in its
// own short tenant transaction. The same cursor always returns the same
// changes plus anything newer (records are read as they are now), so a phone
// may call it twice.
@Injectable()
export class ChangesService {
  constructor(
    private readonly feed: ChangeFeedService,
    private readonly tables: SyncTables,
    private readonly devices: DevicesService,
  ) {}

  async changes(query: ChangesQueryDto, reader: SyncReader): Promise<{ changes: SyncChange[]; nextCursor: string; hasMore: boolean }> {
    const view = syncView(reader);
    const limit = pageLimit(query.limit);
    // 422 for a cursor that is not genuine or not this business's; 410 for
    // another cost or sales visibility or a position older than the retained history.
    const position = await this.feed.open(query.cursor, reader.businessId, view);

    // limit counts log rows, not changes (decided in D3): the cursor moves by
    // exactly the rows read, including rows the reader cannot see and rows
    // that collapse into one change. One row more tells whether there is more.
    const rows = await this.feed.finishedAfter(position, limit + 1);
    const read = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = read[read.length - 1];
    const next: ChangePosition = last ? { txid: last.txid, id: last.id } : position;

    // Several log rows for one record become one change, placed at the
    // record's first appearance (so a parent stays before its children) and
    // built from its state now. Tables the reader cannot see are skipped.
    const order: { table: SyncTableName; id: string; key: string }[] = [];
    const latest = new Map<string, ChangeLogRow>();
    for (const r of read) {
      const entry = this.tables.find(r.tableName);
      if (!entry || (entry.permission !== null && !reader.permissions.has(entry.permission))) continue;
      const key = `${entry.name}:${r.rowId}`;
      if (!latest.has(key)) order.push({ table: entry.name, id: r.rowId, key });
      latest.set(key, r);
    }

    // The current state, one query per table (one after another: queries on
    // one transaction cannot run in parallel). A record not found is a delete,
    // except in tables whose rows are never deleted (sales, Phase E4): there
    // it is a row this reader may not see, skipped without a marker, so an
    // attendant never learns that another member's sale exists.
    const current = new Map<string, SyncRow>();
    for (const table of new Set(order.map((o) => o.table))) {
      const ids = order.filter((o) => o.table === table).map((o) => o.id);
      for (const row of await this.tables.get(table).byIds(ids, view)) current.set(`${table}:${row.id}`, row);
    }
    const changes: SyncChange[] = order.flatMap((o): SyncChange[] => {
      const row = current.get(o.key);
      if (row) return [{ table: o.table, op: 'upsert', id: o.id, row }];
      if (!this.tables.get(o.table).deletes) return [];
      return o.table === 'product_barcode'
        ? [{ table: o.table, op: 'delete', id: o.id, key: { barcode: latest.get(o.key)!.rowKey } }]
        : [{ table: o.table, op: 'delete', id: o.id }];
    });

    // After the data is read, in the same transaction (docs/phase-d-design.md section 3).
    await this.devices.stampSync(reader.deviceId);
    return { changes, nextCursor: this.feed.sign(reader.businessId, next, view), hasMore };
  }
}

/** limit: default 200; above 500 is quietly capped; 0 is refused (as for the other lists). */
function pageLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (n < 1) throw new ApiError(422, 'VALIDATION_FAILED', 'limit must be at least 1.');
  return Math.min(n, MAX_LIMIT);
}
