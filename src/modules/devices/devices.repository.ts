import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';

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
}
