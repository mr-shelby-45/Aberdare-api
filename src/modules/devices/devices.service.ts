import { Injectable } from '@nestjs/common';
import { randomSecret, sha256 } from '../../common/auth/secrets.js';
import { AuditService } from '../audit/audit.service.js';
import { type DeviceForSession, DevicesRepository } from './devices.repository.js';

@Injectable()
export class DevicesService {
  constructor(
    private readonly repo: DevicesRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * Registers a device and issues its secret: 32 random bytes, returned once
   * to the app and stored only as a SHA-256 hash (docs/phase-a-design.md section 7).
   * Every registration (signup, password login, staff activation) is audited here.
   */
  async register(device: {
    name: string;
    platform: string;
    registeredByMembershipId: string;
    now: Date;
  }): Promise<{ deviceId: string; deviceSecret: string }> {
    const deviceSecret = randomSecret();
    const deviceId = await this.repo.create({ ...device, secretHash: sha256(deviceSecret) });
    await this.audit.record({
      action: 'device.registered',
      targetType: 'device',
      targetId: deviceId,
      metadata: { platform: device.platform },
      actorMembershipId: device.registeredByMembershipId,
    });
    return { deviceId, deviceSecret };
  }

  async findForSession(deviceId: string): Promise<DeviceForSession | null> {
    return this.repo.findForSession(deviceId);
  }

  /**
   * Whether the membership may use the device: a personal device belongs to
   * the membership that registered it; a shared device to those linked to it.
   */
  async belongsTo(device: DeviceForSession, membershipId: string): Promise<boolean> {
    if (device.isShared) return this.repo.isLinked(device.id, membershipId);
    return device.registeredByMembershipId === membershipId;
  }

  async touchLastSeen(deviceId: string, now: Date): Promise<void> {
    await this.repo.touchLastSeen(deviceId, now);
  }

  // Data operations for the team module (device endpoints, staff lifecycle).
  list() {
    return this.repo.list();
  }

  update(deviceId: string, fields: { name?: string; isShared?: boolean }) {
    return this.repo.update(deviceId, fields);
  }

  revoke(deviceId: string) {
    return this.repo.revoke(deviceId);
  }

  revokeRegisteredBy(membershipId: string) {
    return this.repo.revokeRegisteredBy(membershipId);
  }

  addLink(deviceId: string, membershipId: string) {
    return this.repo.addLink(deviceId, membershipId);
  }

  removeLink(deviceId: string, membershipId: string) {
    return this.repo.removeLink(deviceId, membershipId);
  }

  removeLinksForMembership(membershipId: string) {
    return this.repo.removeLinksForMembership(membershipId);
  }

  removeLinksForDevice(deviceId: string) {
    return this.repo.removeLinksForDevice(deviceId);
  }
}
