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
}
