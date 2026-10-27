import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api.error.js';
import { SignedCursor, cursorUuid } from '../../common/paging/signed-cursor.js';
import { DevicesService } from '../devices/devices.service.js';
import { LocationsService } from '../locations/locations.service.js';
import { ChangeFeedService } from './change-feed.service.js';
import type { CursorView } from './changes-cursor.js';
import type { SnapshotQueryDto } from './dto/snapshot-query.dto.js';
import { SYNC_TABLE_NAMES, type SyncRow, type SyncTableName, SyncTables, type SyncView } from './sync-tables.js';

const PAGE_KIND = 'sync-snapshot';
const MAX_LIMIT = 500;

/** Who is reading, all from the token and the live session. */
export interface SyncReader {
  businessId: string;
  membershipId: string;
  deviceId: string;
  permissions: ReadonlySet<string>;
}

export interface SnapshotPage {
  table: SyncTableName;
  rows: SyncRow[];
  nextCursor: string | null;
  nextTable: SyncTableName | null;
  startCursor?: string;
}

// GET /v1/sync/snapshot (docs/phase-d-design.md section 5). Each call is one
// ordinary request in its own short tenant transaction; the snapshot is a
// sequence of them, never one long transaction. Nothing is stored per phone.
@Injectable()
export class SnapshotService {
  constructor(
    private readonly tables: SyncTables,
    private readonly feed: ChangeFeedService,
    private readonly cursor: SignedCursor,
    private readonly devices: DevicesService,
    private readonly locations: LocationsService,
  ) {}

  /**
   * Without table or cursor: the start of a snapshot. start_cursor is taken
   * first, before any row is read, so everything this download might miss is
   * delivered later by changes from it (decided in D1: the start position).
   * With table and no cursor: the first page of that table. With both: the
   * next page. A page cursor is bound to its business and table.
   */
  async page(query: SnapshotQueryDto, reader: SyncReader): Promise<SnapshotPage> {
    const { view, cursorView } = await syncView(reader, this.locations);
    const limit = pageLimit(query.limit);
    let table: SyncTableName;
    let after: string | null = null;
    let startCursor: string | undefined;
    if (query.cursor !== undefined) {
      if (query.table === undefined) throw invalid('Send table with cursor.');
      const v = this.cursor.read(PAGE_KIND, query.cursor);
      const afterId = cursorUuid(v?.after_id);
      if (!v || cursorUuid(v.business_id) !== reader.businessId || v.table !== query.table || !afterId) {
        throw invalid('The cursor is not valid.');
      }
      table = query.table;
      after = afterId;
    } else if (query.table !== undefined) {
      table = query.table;
    } else {
      startCursor = await this.feed.startCursor(reader.businessId, cursorView);
      table = SYNC_TABLE_NAMES[0];
    }

    const entry = this.tables.get(table);
    const visible = entry.permission === null || reader.permissions.has(entry.permission);
    // One row more than asked tells whether there is a next page.
    const rows = visible ? await entry.page(after, limit + 1, view) : [];
    const page = rows.slice(0, limit);
    const more = rows.length > limit;
    const last = page[page.length - 1];

    // After the data is read, in the same transaction (docs/phase-d-design.md section 3).
    await this.devices.stampSync(reader.deviceId);

    return {
      table,
      rows: page,
      nextCursor: more && last ? this.cursor.sign(PAGE_KIND, { business_id: reader.businessId, table, after_id: last.id }) : null,
      nextTable: more ? null : this.tables.next(table),
      ...(startCursor !== undefined ? { startCursor } : {}),
    };
  }
}

/**
 * What this reader may see, from the live session (Phase D costs; Phase E4
 * sales) and the location scope resolved now (Phase T2), and what the changes
 * cursor binds of it.
 */
export async function syncView(reader: SyncReader, locations: LocationsService): Promise<{ view: SyncView; cursorView: CursorView }> {
  const scope = await locations.scopeOf(reader.membershipId);
  const costs = reader.permissions.has('costs.view');
  const allSales = reader.permissions.has('sales.void');
  return {
    view: { costs, allSales, membershipId: reader.membershipId, locationIds: scope.ids() },
    cursorView: { costs, allSales, scope: scope.digest() },
  };
}

/** limit: default 500; above 500 is quietly capped; 0 is refused (as for the other lists). */
function pageLimit(raw: string | undefined): number {
  if (raw === undefined) return MAX_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (n < 1) throw invalid('limit must be at least 1.');
  return Math.min(n, MAX_LIMIT);
}

function invalid(message: string): ApiError {
  return new ApiError(422, 'VALIDATION_FAILED', message);
}
