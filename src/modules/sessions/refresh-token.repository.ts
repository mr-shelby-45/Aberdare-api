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

  /** Revokes every live token matching the filter. Returns how many. */
  async revoke(
    where: { familyId?: string; membershipId?: string; deviceId?: string },
    now: Date,
  ): Promise<number> {
    const { count } = await currentTx().refreshToken.updateMany({
      where: { ...where, revokedAt: null },
      data: { revokedAt: now },
    });
    return count;
  }
}
