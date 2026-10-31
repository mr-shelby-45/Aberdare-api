import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';

export interface DeviceForSession {
  id: string;
  name: string;
  isShared: boolean;
  status: string;
  registeredByMembershipId: string;
}

@Injectable()
export class DevicesRepository {
  /** Returns the new device id. Only the secret's hash is stored. */
  async create(device: {
    name: string;
    platform: string;
    secretHash: string;
    registeredByMembershipId: string;
    now: Date;
  }): Promise<string> {
    const row = await currentTx().device.create({
      data: {
        businessId: currentBusinessId(),
        name: device.name,
        platform: device.platform,
        secretHash: device.secretHash,
        status: 'ACTIVE',
        registeredByMembershipId: device.registeredByMembershipId,
        lastSeenAt: device.now,
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * Phase T4: the newest last_sync_at among a member's active devices: those
   * they registered and shared tablets linked to them. Null when none synced.
   */
  async lastSyncOf(membershipId: string): Promise<Date | null> {
    const rows = await currentTx().$queryRaw<{ last: Date | null }[]>`
      SELECT max(d.last_sync_at) AS last
        FROM device d
       WHERE d.business_id = ${currentBusinessId()}::uuid AND d.status = 'ACTIVE'
         AND (d.registered_by_membership_id = ${membershipId}::uuid
              OR EXISTS (SELECT 1 FROM device_membership dm
                          WHERE dm.business_id = d.business_id AND dm.device_id = d.id AND dm.membership_id = ${membershipId}::uuid))`;
    return rows[0]?.last ?? null;
  }

  /**
   * Phase T6: the member's personal devices, in any status: registered by
   * them (device.registered_by_membership_id) and not shared (device.is_shared
   * = false). A revoked phone still counts for what was recorded on it.
   */
  async personalDeviceIdsOf(membershipId: string): Promise<string[]> {
    const rows = await currentTx().device.findMany({ where: { registeredByMembershipId: membershipId, isShared: false }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  /**
   * Phase F3: where a member's pushes go: their active personal devices
   * (registered by them, not shared) that have a push token. A shared tablet
   * never gets a member's push.
   */
  async pushTargetsOf(membershipIds: string[]): Promise<{ deviceId: string; membershipId: string; token: string }[]> {
    if (membershipIds.length === 0) return [];
    const rows = await currentTx().device.findMany({
      where: { registeredByMembershipId: { in: membershipIds }, isShared: false, status: 'ACTIVE', pushToken: { not: null } },
      orderBy: { id: 'asc' },
      select: { id: true, registeredByMembershipId: true, pushToken: true },
    });
    return rows.map((r) => ({ deviceId: r.id, membershipId: r.registeredByMembershipId, token: r.pushToken! }));
  }

  /** Phase F3: clears a dead token, only if the device still holds that same token (a newly set one is kept). */
  async clearPushToken(deviceId: string, token: string): Promise<void> {
    await currentTx().device.updateMany({ where: { id: deviceId, pushToken: token }, data: { pushToken: null } });
  }

  /** Phase F3: sets (or clears, with null) this device's token; any other device of the business holding it loses it. */
  async setPushToken(deviceId: string, token: string | null): Promise<void> {
    if (token !== null) {
      await currentTx().device.updateMany({ where: { pushToken: token, id: { not: deviceId } }, data: { pushToken: null } });
    }
    await currentTx().device.updateMany({ where: { id: deviceId }, data: { pushToken: token } });
  }

  async findForSession(deviceId: string): Promise<DeviceForSession | null> {
    return currentTx().device.findUnique({
      where: { id: deviceId },
      select: { id: true, name: true, isShared: true, status: true, registeredByMembershipId: true },
    });
  }

  /** Whether the membership may sell on this (shared) device. */
  async isLinked(deviceId: string, membershipId: string): Promise<boolean> {
    const link = await currentTx().deviceMembership.findFirst({
      where: { deviceId, membershipId },
      select: { id: true },
    });
    return link !== null;
  }

  async list() {
    return currentTx().device.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        platform: true,
        isShared: true,
        status: true,
        lastSeenAt: true,
        registeredByMembershipId: true,
      },
    });
  }

  async update(deviceId: string, fields: { name?: string; isShared?: boolean }): Promise<void> {
    await currentTx().device.updateMany({ where: { id: deviceId }, data: fields });
  }

  /** Returns false if it was already revoked (or not found). */
  async revoke(deviceId: string): Promise<boolean> {
    const { count } = await currentTx().device.updateMany({
      where: { id: deviceId, status: 'ACTIVE' },
      data: { status: 'REVOKED' },
    });
    return count === 1;
  }

  /** Revokes every active device the membership registered. Returns their ids. */
  async revokeRegisteredBy(membershipId: string): Promise<string[]> {
    const devices = await currentTx().device.findMany({
      where: { registeredByMembershipId: membershipId, status: 'ACTIVE' },
      select: { id: true },
    });
    await currentTx().device.updateMany({
      where: { id: { in: devices.map((d) => d.id) } },
      data: { status: 'REVOKED' },
    });
    return devices.map((d) => d.id);
  }

  /** Idempotent: linking twice changes nothing. */
  async addLink(deviceId: string, membershipId: string): Promise<void> {
    await currentTx().$executeRaw`
      INSERT INTO device_membership (business_id, device_id, membership_id)
      VALUES (${currentBusinessId()}::uuid, ${deviceId}::uuid, ${membershipId}::uuid)
      ON CONFLICT (business_id, device_id, membership_id) DO NOTHING`;
  }

  async removeLink(deviceId: string, membershipId: string): Promise<number> {
    const { count } = await currentTx().deviceMembership.deleteMany({ where: { deviceId, membershipId } });
    return count;
  }

  /** Removes the membership from every shared device. */
  async removeLinksForMembership(membershipId: string): Promise<void> {
    await currentTx().deviceMembership.deleteMany({ where: { membershipId } });
  }

  /** Removes every link of the device. Returns the membership ids that were linked. */
  async removeLinksForDevice(deviceId: string): Promise<string[]> {
    const links = await currentTx().deviceMembership.findMany({ where: { deviceId }, select: { membershipId: true } });
    await currentTx().deviceMembership.deleteMany({ where: { deviceId } });
    return links.map((l) => l.membershipId);
  }

  async touchLastSeen(deviceId: string, now: Date): Promise<void> {
    await currentTx().device.updateMany({ where: { id: deviceId }, data: { lastSeenAt: now } });
  }

  /**
   * Stamps last_sync_at unless it was stamped less than `minutes` ago. One
   * atomic statement: concurrent calls each either write or not, never fail.
   */
  async stampSync(deviceId: string, now: Date, minutes: number): Promise<boolean> {
    const count = await currentTx().$executeRaw`
      UPDATE device SET last_sync_at = ${now}::timestamptz
       WHERE id = ${deviceId}::uuid
         AND business_id = ${currentBusinessId()}::uuid
         AND (last_sync_at IS NULL OR last_sync_at < ${now}::timestamptz - make_interval(mins => ${minutes}::int))`;
    return count === 1;
  }
}
