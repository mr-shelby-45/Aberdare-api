import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { CreateLocationDto } from './dto/create-location.dto.js';
import { ListLocationsQueryDto } from './dto/list-locations-query.dto.js';
import { UpdateLocationDto } from './dto/update-location.dto.js';
import type { LocationRow } from './locations.repository.js';
import { LocationsService } from './locations.service.js';

// Locations (docs/phase-b-design.md section 6). Online only: the one REST
// write for catalogue-like data. Reads need only an active membership.
@Controller('v1/locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get()
  async list(@Query() query: ListLocationsQueryDto) {
    const rows = await this.locations.list(query.include_archived === 'true');
    return { locations: rows.map(toJson) };
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('locations.manage')
  async create(@Body() dto: CreateLocationDto) {
    return toJson(await this.locations.create(dto));
  }

  @Patch(':id')
  @HttpCode(200)
  @RequirePermission('locations.manage')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLocationDto) {
    return toJson(await this.locations.update(id, dto));
  }
}

function toJson(l: LocationRow) {
  return { id: l.id, name: l.name, is_default: l.isDefault, kind: l.kind, assigned_membership_id: l.assignedMembershipId, archived: l.archivedAt !== null };
}
