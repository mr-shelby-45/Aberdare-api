import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';

@Injectable()
export class RefreshTokenRepository {
  async create(token: {
    membershipId: string;
    deviceId: string;
    familyId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
    await currentTx().refreshToken.create({
      data: { businessId: currentBusinessId(), ...token },
      select: { id: true },
    });
  }

  /** Reuse detected: every token in the family stops working. Returns how many were revoked. */
  async revokeFamily(familyId: string, now: Date): Promise<number> {
    const { count } = await currentTx().refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    });
    return count;
  }

  /** Logout: every live token of this membership on this device. */
  async revokeForDevice(membershipId: string, deviceId: string, now: Date): Promise<number> {
    const { count } = await currentTx().refreshToken.updateMany({
      where: { membershipId, deviceId, revokedAt: null },
      data: { revokedAt: now },
    });
    return count;
  }
}
