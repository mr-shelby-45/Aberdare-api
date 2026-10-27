import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api.error.js';
import { SignedCursor, cursorUuid } from '../../common/paging/signed-cursor.js';
import type { ChangePosition } from './change-log.repository.js';

const KIND = 'sync-changes';
// A 64-bit unsigned number as decimal text.
const NUMBER = /^\d{1,20}$/;

/**
 * What the reader could see when a cursor was issued: costs (Phase D), all
 * sales or only their own (Phase E4), and the location scope (Phase T2: "all"
 * or a digest of the allowed location ids).
 */
export interface CursorView {
  costs: boolean;
  allSales: boolean;
  scope: string;
}

// The cursor of GET /v1/sync/changes (docs/phase-d-design.md section 4): the
// shared signed cursor carrying the business, the last position returned and
// what the member could see when it was issued (costs; from E4 also all
// sales). Opaque to the phone, and not tied to a device.
@Injectable()
export class ChangesCursor {
  constructor(private readonly cursor: SignedCursor) {}

  sign(businessId: string, position: ChangePosition, view: CursorView): string {
    return this.cursor.sign(KIND, { business_id: businessId, txid: position.txid, id: position.id, costs: view.costs, all_sales: view.allSales, scope: view.scope });
  }

  /**
   * The position, if the cursor is genuine and was issued to this business.
   * Tampered, malformed, unsigned, or another business's: the same 422 (so a
   * cursor never reveals that another business exists; a cursor from before
   * E4 or T2, without all_sales or scope, too). Issued under another cost,
   * sales or location visibility: 410 SNAPSHOT_REQUIRED, either direction. The retention
   * check (also 410) needs the database: ChangeFeedService.open().
   */
  read(raw: string, businessId: string, view: CursorView): ChangePosition {
    const v = this.cursor.read(KIND, raw);
    if (
      !v ||
      cursorUuid(v.business_id) !== businessId ||
      typeof v.txid !== 'string' ||
      !NUMBER.test(v.txid) ||
      typeof v.id !== 'string' ||
      !NUMBER.test(v.id) ||
      typeof v.costs !== 'boolean' ||
      typeof v.all_sales !== 'boolean' ||
      typeof v.scope !== 'string'
    ) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'The cursor is not valid.');
    }
    if (v.costs !== view.costs || v.all_sales !== view.allSales || v.scope !== view.scope) throw snapshotRequired();
    return { txid: v.txid, id: v.id };
  }
}

export function snapshotRequired(): ApiError {
  return new ApiError(410, 'SNAPSHOT_REQUIRED', 'Your copy is out of date. Download a fresh snapshot.');
}
