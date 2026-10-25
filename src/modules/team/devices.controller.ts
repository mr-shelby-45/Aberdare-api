import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { DeviceAdminService } from './device-admin.service.js';
import { AddDeviceMemberDto } from './dto/add-device-member.dto.js';
import { UpdateDeviceDto } from './dto/update-device.dto.js';

@Controller('v1/devices')
@RequirePermission('devices.manage')
export class DevicesController {
  constructor(private readonly admin: DeviceAdminService) {}

  @Get()
  async list() {
    return { devices: await this.admin.list() };
  }

  @Patch(':id')
  @HttpCode(204)
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDeviceDto) {
    await this.admin.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(@Param('id', ParseUUIDPipe) id: string) {
    await this.admin.revoke(id);
  }

  @Post(':id/members')
  @HttpCode(204)
  async addMember(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddDeviceMemberDto) {
    await this.admin.addMember(id, dto.membership_id);
  }

  @Delete(':id/members/:membershipId')
  @HttpCode(204)
  async removeMember(@Param('id', ParseUUIDPipe) id: string, @Param('membershipId', ParseUUIDPipe) membershipId: string) {
    await this.admin.removeMember(id, membershipId);
  }
}
