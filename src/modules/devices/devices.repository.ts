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

  async touchLastSeen(deviceId: string, now: Date): Promise<void> {
    await currentTx().device.updateMany({ where: { id: deviceId }, data: { lastSeenAt: now } });
  }
}
