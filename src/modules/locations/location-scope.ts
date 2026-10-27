import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { StaffService } from '../staff/staff.service.js';
import { LocationsRepository } from './locations.repository.js';

/**
 * Which locations a member may sell from and see (docs/phase-t-design.md
 * section 4). null means all of the business's locations; otherwise exactly
 * these ids (possibly none).
 */
export class ResolvedScope {
  constructor(readonly allowedIds: ReadonlySet<string> | null) {}

  allows(locationId: string): boolean {
    return this.allowedIds === null || this.allowedIds.has(locationId);
  }

  /** The ids for a query filter, or null for all. */
  ids(): string[] | null {
    return this.allowedIds === null ? null : [...this.allowedIds].sort();
  }

  /**
   * "all", or a short fingerprint of the sorted allowed ids, for the changes
   * cursor: any change in scope gives a different value (decided in T2: the
   * first 16 hex characters of a SHA-256).
   */
  digest(): string {
    const ids = this.ids();
    return ids === null ? 'all' : createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 16);
  }
}

// The location scope (Phase T2): the one place that decides. A member with the
// FIELD_ATTENDANT preset is restricted to the locations assigned to them,
// active or archived (an offline sale into a location archived meanwhile is
// still accepted); everyone else is unrestricted. Resolved inside the current
// tenant transaction from the live membership row, per command and per
// request, never copied into a token or the session.
@Injectable()
export class LocationScope {
  constructor(
    private readonly staff: StaffService,
    private readonly repo: LocationsRepository,
  ) {}

  async resolve(membershipId: string): Promise<ResolvedScope> {
    const member = await this.staff.findForSession(membershipId);
    if (member?.rolePreset !== 'FIELD_ATTENDANT') return new ResolvedScope(null);
    return new ResolvedScope(new Set(await this.repo.assignedIds(membershipId)));
  }
}
