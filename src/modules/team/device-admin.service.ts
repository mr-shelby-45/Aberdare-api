import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api.error.js';
import { Clock } from '../../common/time/clock.js';
import { DevicesService } from '../devices/devices.service.js';
import { RefreshTokensService } from '../sessions/refresh-tokens.service.js';
import { StaffService } from '../staff/staff.service.js';
import type { UpdateDeviceDto } from './dto/update-device.dto.js';
import { notFound } from './staff-rules.js';

// The device endpoints (docs/phase-a-design.md section 11). Runs inside the
// request's tenant transaction.
@Injectable()
export class DeviceAdminService {
  constructor(
    private readonly devices: DevicesService,
    private readonly staff: StaffService,
    private readonly refreshTokens: RefreshTokensService,
    private readonly clock: Clock,
  ) {}

  async list() {
    // One after the other: queries on one transaction cannot run in parallel.
    const devices = await this.devices.list();
    const members = await this.staff.list();
    const names = new Map(members.map((m) => [m.id, m.displayName]));
    return devices.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      is_shared: d.isShared,
      status: d.status,
      last_seen_at: d.lastSeenAt?.toISOString() ?? null,
      registered_by: names.get(d.registeredByMembershipId) ?? null,
    }));
  }

  /**
   * Rename, or turn shared on or off. Turning it off removes every tablet
   * link and ends the linked members' sessions on this device; the device then
   * belongs to whoever registered it.
   */
  async update(id: string, dto: UpdateDeviceDto): Promise<void> {
    const device = await this.devices.findForSession(id);
    if (!device) throw notFound();
    await this.devices.update(id, { name: dto.name, isShared: dto.is_shared });
    if (dto.is_shared === false && device.isShared) {
      const now = this.clock.now();
      for (const membershipId of await this.devices.removeLinksForDevice(id)) {
        if (membershipId !== device.registeredByMembershipId) {
          await this.refreshTokens.revokeForMembershipOnDevice(membershipId, id, now);
        }
      }
    }
  }

  /** Status REVOKED, and every session on it ends. */
  async revoke(id: string): Promise<void> {
    const device = await this.devices.findForSession(id);
    if (!device) throw notFound();
    await this.devices.revoke(id);
    await this.refreshTokens.revokeForDevice(id, this.clock.now());
  }

  async addMember(deviceId: string, membershipId: string): Promise<void> {
    const device = await this.devices.findForSession(deviceId);
    if (!device) throw notFound();
    if (!device.isShared || device.status !== 'ACTIVE') {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Only an active shared device can have members.');
    }
    const member = await this.staff.findForSession(membershipId);
    if (!member || member.status !== 'ACTIVE') {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Only active staff can be added to a device.');
    }
    await this.devices.addLink(deviceId, membershipId);
  }

  async removeMember(deviceId: string, membershipId: string): Promise<void> {
    if ((await this.devices.removeLink(deviceId, membershipId)) === 0) throw notFound();
    await this.refreshTokens.revokeForMembershipOnDevice(membershipId, deviceId, this.clock.now());
  }
}
