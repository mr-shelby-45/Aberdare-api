import { Injectable } from '@nestjs/common';
import { Clock } from '../../common/time/clock.js';
import { AppConfig } from '../../config/app.config.js';
import { ChangeLogMaintenance } from '../../database/change-log-maintenance.js';
import { type ChangeLogRow, type ChangePosition, ChangeLogRepository } from './change-log.repository.js';
import { ChangesCursor, snapshotRequired } from './changes-cursor.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// The change feed behind GET /v1/sync/snapshot and /changes (Phase D1,
// docs/phase-d-design.md sections 4 and 7): where a reader starts, which log
// rows are safe to hand out, whether a cursor is still usable, and the prune.
// Every method except prune() runs inside a tenant transaction.
@Injectable()
export class ChangeFeedService {
  constructor(
    private readonly repo: ChangeLogRepository,
    private readonly cursor: ChangesCursor,
    private readonly maintenance: ChangeLogMaintenance,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  /** A cursor for a reader that has everything finished so far (the snapshot's start_cursor). */
  async startCursor(businessId: string, costs: boolean): Promise<string> {
    return this.cursor.sign(businessId, await this.repo.startPosition(), costs);
  }

  /**
   * The position of a cursor the phone sent back: 422 if it is not genuine or
   * not this business's, 410 if it was issued under another cost visibility
   * or is older than the retained history.
   */
  async open(raw: string, businessId: string, costs: boolean): Promise<ChangePosition> {
    const position = this.cursor.read(raw, businessId, costs);
    if (!(await this.repo.isRetained(position))) throw snapshotRequired();
    return position;
  }

  /** Log rows after the position, from finished transactions only, in (txid, id) order. */
  async finishedAfter(position: ChangePosition, limit: number): Promise<ChangeLogRow[]> {
    return this.repo.finishedAfter(position, limit);
  }

  sign(businessId: string, position: ChangePosition, costs: boolean): string {
    return this.cursor.sign(businessId, position, costs);
  }

  /**
   * Removes change_log rows older than the retention (by the Clock), for
   * every business. Outside any tenant transaction. Not called until Phase F.
   */
  async prune(): Promise<string> {
    const before = new Date(this.clock.now().getTime() - this.config.changeLogRetentionDays * DAY_MS);
    return this.maintenance.prune(before);
  }
}
