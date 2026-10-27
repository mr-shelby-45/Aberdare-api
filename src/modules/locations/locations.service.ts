import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api.error.js';
import { Clock } from '../../common/time/clock.js';
import { uniqueViolationConstraint } from '../../database/db-errors.js';
import { AuditService } from '../audit/audit.service.js';
import { StaffService } from '../staff/staff.service.js';
import { LocationScope, type ResolvedScope } from './location-scope.js';
import type { CreateLocationDto } from './dto/create-location.dto.js';
import type { UpdateLocationDto } from './dto/update-location.dto.js';
import { type LocationRow, LocationsRepository } from './locations.repository.js';

export const DEFAULT_LOCATION_NAME = 'Main shop';

// Locations (docs/phase-b-design.md sections 3 and 6). Runs inside a tenant
// transaction: the request's, or signup's. Every change, its change_log row
// (trigger) and its audit row commit together.
@Injectable()
export class LocationsService {
  constructor(
    private readonly repo: LocationsRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly staff: StaffService,
    private readonly scope: LocationScope,
  ) {}

  /** The member's location scope (Phase T2), resolved now from the live membership. */
  async scopeOf(membershipId: string): Promise<ResolvedScope> {
    return this.scope.resolve(membershipId);
  }

  /**
   * Phase T2: the location, if it exists in this business and the member's
   * scope allows it. null for a missing one, another business's, and one
   * outside the scope alike, so the scope never reveals that a location exists.
   */
  async findInScope(id: string, membershipId: string): Promise<LocationRow | null> {
    const location = await this.repo.findById(id);
    if (!location || !(await this.scope.resolve(membershipId)).allows(id)) return null;
    return location;
  }

  /** The default location, created by signup in the signup transaction. */
  async createDefault(actorMembershipId: string): Promise<LocationRow> {
    const location = await this.repo.create({ name: DEFAULT_LOCATION_NAME, isDefault: true });
    await this.audit.record({
      action: 'location.created',
      targetType: 'location',
      targetId: location.id,
      metadata: { is_default: true, ...kindOf(location) },
      actorMembershipId,
    });
    return location;
  }

  /** For the sync snapshot (Phase D2): every location in scope (Phase T2: null = all), archived too, in id order. */
  async pageForSync(afterId: string | null, limit: number, onlyIds: string[] | null = null): Promise<LocationRow[]> {
    return this.repo.pageForSync(afterId, limit, onlyIds);
  }

  /** For sync changes (Phase D3): these locations as they are now, only those in scope (Phase T2: null = all); others are absent. */
  async byIdsForSync(ids: string[], onlyIds: string[] | null = null): Promise<LocationRow[]> {
    const allowed = onlyIds === null ? null : new Set(onlyIds);
    return (await this.repo.byIdsForSync(ids)).filter((l) => allowed === null || allowed.has(l.id));
  }

  /** For the stock commands (Phase C2). Another business's id gives null, like a missing one. */
  async findById(id: string): Promise<LocationRow | null> {
    return this.repo.findById(id);
  }

  /** GET /v1/locations: a field attendant sees only the locations assigned to them (Phase T2). */
  async list(includeArchived: boolean, membershipId: string): Promise<LocationRow[]> {
    return this.repo.list(includeArchived, (await this.scope.resolve(membershipId)).ids());
  }

  /**
   * A shop, warehouse or (Phase T) field location. A FIELD location needs an
   * assignee who is an invited or active FIELD_ATTENDANT of this business;
   * other kinds take none. One active field location per member (a partial
   * unique index): a reassignment is "archive the old one, create a new one".
   */
  async create(dto: CreateLocationDto): Promise<LocationRow> {
    const kind = dto.kind ?? 'SHOP';
    const assignee = dto.assigned_membership_id ?? null;
    if ((kind === 'FIELD') !== (assignee !== null)) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'A field location needs assigned_membership_id; other kinds take none.');
    }
    if (assignee !== null) {
      const member = await this.staff.findForSession(assignee);
      // The same answer for a missing member, another business's, and a wrong preset or status.
      if (!member || member.rolePreset !== 'FIELD_ATTENDANT' || (member.status !== 'ACTIVE' && member.status !== 'INVITED')) {
        throw new ApiError(422, 'ASSIGNEE_INVALID', 'A field location must be assigned to an active or invited field attendant.');
      }
    }
    const location = await oneActiveField(() => this.repo.create({ name: cleanName(dto.name), isDefault: false, kind, assignedMembershipId: assignee }));
    await this.audit.record({
      action: 'location.created',
      targetType: 'location',
      targetId: location.id,
      metadata: { is_default: false, ...kindOf(location) },
    });
    return location;
  }

  /** Rename, archive or restore. Fields left out stay as they are. */
  async update(id: string, dto: UpdateLocationDto): Promise<LocationRow> {
    if (dto.name === undefined && dto.archived === undefined) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Send name or archived.');
    }
    const location = await this.repo.findById(id);
    if (!location) throw notFound();

    if (dto.name !== undefined) {
      const name = cleanName(dto.name);
      if (name !== location.name) {
        await this.repo.rename(id, name);
        await this.audit.record({
          action: 'location.updated',
          targetType: 'location',
          targetId: id,
          metadata: { name_before: location.name, name_after: name, ...kindOf(location) },
        });
      }
    }

    const archived = location.archivedAt !== null;
    if (dto.archived === true && !archived) {
      if (location.isDefault) {
        throw new ApiError(422, 'LOCATION_IS_DEFAULT', 'The default location cannot be archived.');
      }
      if (!(await this.repo.archive(id, this.clock.now()))) {
        throw new ApiError(422, 'LAST_ACTIVE_LOCATION', 'A business needs at least one active location.');
      }
      await this.audit.record({ action: 'location.archived', targetType: 'location', targetId: id, metadata: kindOf(location) });
    } else if (dto.archived === false && archived) {
      // A field location whose member has another active one stays archived.
      await oneActiveField(() => this.repo.restore(id));
      await this.audit.record({ action: 'location.restored', targetType: 'location', targetId: id, metadata: kindOf(location) });
    }

    const updated = await this.repo.findById(id);
    if (!updated) throw notFound();
    return updated;
  }
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 60) {
    throw new ApiError(422, 'VALIDATION_FAILED', 'Invalid fields: name');
  }
  return trimmed;
}

/** Phase T: the kind and assignee, in every location audit row. */
function kindOf(l: LocationRow): { kind: string; assigned_membership_id: string | null } {
  return { kind: l.kind, assigned_membership_id: l.assignedMembershipId };
}

/** Maps the one-active-field-location index (Phase T1) to 409 FIELD_LOCATION_EXISTS. */
async function oneActiveField<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (uniqueViolationConstraint(err) === 'location_one_active_field_per_member') {
      throw new ApiError(409, 'FIELD_LOCATION_EXISTS', 'This member already has an active field location.');
    }
    throw err;
  }
}

/** Same answer for another business's id and a missing one. */
function notFound(): ApiError {
  return new ApiError(404, 'LOCATION_NOT_FOUND', 'Location not found.');
}
