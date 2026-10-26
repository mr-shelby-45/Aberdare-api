import { Injectable } from '@nestjs/common';
import { randomSecret, sha256 } from '../../common/auth/secrets.js';
import { Clock } from '../../common/time/clock.js';
import { AuditService } from '../audit/audit.service.js';
import { type DeviceForSession, DevicesRepository } from './devices.repository.js';

// How often the sync stamp may write, at most (docs/phase-d-design.md section 2).
const SYNC_STAMP_MINUTES = 5;

@Injectable()
export class DevicesService {
  constructor(
    private readonly repo: DevicesRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
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

  /**
   * The sync freshness stamp (Phase D1, docs/phase-d-design.md section 3):
   * last_sync_at on the calling device, at most once every 5 minutes, so
   * phones polling often cause no write storm. One conditional statement;
   * zero rows updated is normal. No change_log row (device has no trigger)
   * and no audit row. Runs inside the request's tenant transaction, after
   * the data is read. Returns whether it wrote.
   */
  async stampSync(deviceId: string): Promise<boolean> {
    return this.repo.stampSync(deviceId, this.clock.now(), SYNC_STAMP_MINUTES);
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
