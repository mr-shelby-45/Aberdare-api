import { Injectable } from '@nestjs/common';
import { RefreshTokenRepository } from './refresh-token.repository.js';

// The refresh_token table: creating tokens and revoking them. Used by auth
// (login, refresh, logout) and team (suspend, remove, reset, device changes).
// Every method runs inside the current tenant transaction.
@Injectable()
export class RefreshTokensService {
  constructor(private readonly repo: RefreshTokenRepository) {}

  async create(token: { membershipId: string; deviceId: string; familyId: string; tokenHash: string; expiresAt: Date }): Promise<void> {
    await this.repo.create(token);
  }

  /** Reuse detected: every token in the family stops working. */
  async revokeFamily(familyId: string, now: Date): Promise<number> {
    return this.repo.revoke({ familyId }, now);
  }

  /** Logout, or a member taken off a shared device: this membership on this device. */
  async revokeForMembershipOnDevice(membershipId: string, deviceId: string, now: Date): Promise<number> {
    return this.repo.revoke({ membershipId, deviceId }, now);
  }

  /** Suspend, remove, PIN reset: everywhere for this membership. */
  async revokeForMembership(membershipId: string, now: Date): Promise<number> {
    return this.repo.revoke({ membershipId }, now);
  }

  /** Device revoked: everyone on this device. */
  async revokeForDevice(deviceId: string, now: Date): Promise<number> {
    return this.repo.revoke({ deviceId }, now);
  }
}
