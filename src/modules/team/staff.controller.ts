import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import type { AuthedRequest } from '../../common/auth/request-auth.js';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { CreateStaffDto } from './dto/create-staff.dto.js';
import { UpdateStaffDto } from './dto/update-staff.dto.js';
import { StaffLifecycleService } from './staff-lifecycle.service.js';

@Controller('v1/staff')
@RequirePermission('staff.manage')
export class StaffController {
  constructor(private readonly lifecycle: StaffLifecycleService) {}

  @Post()
  @HttpCode(201)
  async create(@Req() request: AuthedRequest, @Body() dto: CreateStaffDto) {
    const r = await this.lifecycle.create(request.session!, dto);
    return { membership_id: r.membershipId, temp_pin: r.tempPin, temp_pin_expires_at: r.tempPinExpiresAt.toISOString() };
  }

  @Get()
  async list() {
    return { staff: await this.lifecycle.list() };
  }

  @Patch(':id')
  @HttpCode(204)
  async update(@Req() request: AuthedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStaffDto) {
    await this.lifecycle.update(request.session!, id, dto);
  }

  @Post(':id/reset-pin')
  @HttpCode(200)
  async resetPin(@Req() request: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.lifecycle.resetPin(request.session!, id);
    return { membership_id: r.membershipId, temp_pin: r.tempPin, temp_pin_expires_at: r.tempPinExpiresAt.toISOString() };
  }

  @Post(':id/suspend')
  @HttpCode(204)
  async suspend(@Req() request: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await this.lifecycle.suspend(request.session!, id);
  }

  @Post(':id/reactivate')
  @HttpCode(204)
  async reactivate(@Req() request: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await this.lifecycle.reactivate(request.session!, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() request: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await this.lifecycle.remove(request.session!, id);
  }
}
