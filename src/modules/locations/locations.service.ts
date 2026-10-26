import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api.error.js';
import { Clock } from '../../common/time/clock.js';
import { AuditService } from '../audit/audit.service.js';
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
  ) {}

  /** The default location, created by signup in the signup transaction. */
  async createDefault(actorMembershipId: string): Promise<LocationRow> {
    const location = await this.repo.create({ name: DEFAULT_LOCATION_NAME, isDefault: true });
    await this.audit.record({
      action: 'location.created',
      targetType: 'location',
      targetId: location.id,
      metadata: { is_default: true },
      actorMembershipId,
    });
    return location;
  }

  /** For the stock commands (Phase C2). Another business's id gives null, like a missing one. */
  async findById(id: string): Promise<LocationRow | null> {
    return this.repo.findById(id);
  }

  async list(includeArchived: boolean): Promise<LocationRow[]> {
    return this.repo.list(includeArchived);
  }

  async create(dto: CreateLocationDto): Promise<LocationRow> {
    const location = await this.repo.create({ name: cleanName(dto.name), isDefault: false });
    await this.audit.record({
      action: 'location.created',
      targetType: 'location',
      targetId: location.id,
      metadata: { is_default: false },
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
          metadata: { name_before: location.name, name_after: name },
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
      await this.audit.record({ action: 'location.archived', targetType: 'location', targetId: id });
    } else if (dto.archived === false && archived) {
      await this.repo.restore(id);
      await this.audit.record({ action: 'location.restored', targetType: 'location', targetId: id });
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

/** Same answer for another business's id and a missing one. */
function notFound(): ApiError {
  return new ApiError(404, 'LOCATION_NOT_FOUND', 'Location not found.');
}
