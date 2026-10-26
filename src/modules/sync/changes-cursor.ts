import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api.error.js';
import { SignedCursor, cursorUuid } from '../../common/paging/signed-cursor.js';
import type { ChangePosition } from './change-log.repository.js';

const KIND = 'sync-changes';
// A 64-bit unsigned number as decimal text.
const NUMBER = /^\d{1,20}$/;

// The cursor of GET /v1/sync/changes (docs/phase-d-design.md section 4): the
// shared signed cursor carrying the business, the last position returned and
// whether the member could see costs when it was issued. Opaque to the phone,
// and not tied to a device.
@Injectable()
export class ChangesCursor {
  constructor(private readonly cursor: SignedCursor) {}

  sign(businessId: string, position: ChangePosition, costs: boolean): string {
    return this.cursor.sign(KIND, { business_id: businessId, txid: position.txid, id: position.id, costs });
  }

  /**
   * The position, if the cursor is genuine and was issued to this business.
   * Tampered, malformed, unsigned, or another business's: the same 422 (so a
   * cursor never reveals that another business exists). Issued under another
   * cost visibility: 410 SNAPSHOT_REQUIRED, either direction. The retention
   * check (also 410) needs the database: ChangeFeedService.open().
   */
  read(raw: string, businessId: string, costs: boolean): ChangePosition {
    const v = this.cursor.read(KIND, raw);
    if (
      !v ||
      cursorUuid(v.business_id) !== businessId ||
      typeof v.txid !== 'string' ||
      !NUMBER.test(v.txid) ||
      typeof v.id !== 'string' ||
      !NUMBER.test(v.id) ||
      typeof v.costs !== 'boolean'
    ) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'The cursor is not valid.');
    }
    if (v.costs !== costs) throw snapshotRequired();
    return { txid: v.txid, id: v.id };
  }
}

export function snapshotRequired(): ApiError {
  return new ApiError(410, 'SNAPSHOT_REQUIRED', 'Your copy is out of date. Download a fresh snapshot.');
}
