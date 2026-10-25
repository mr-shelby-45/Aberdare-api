import { Injectable } from '@nestjs/common';
import type { RequestAuth, RequestSession } from '../../common/auth/request-auth.js';
import { sha256 } from '../../common/auth/secrets.js';
import { ApiError } from '../../common/errors/api.error.js';
import { Clock } from '../../common/time/clock.js';
import { IdentityLookup } from '../../database/identity-lookup.js';
import { TenantRunner } from '../../database/tenant.js';
import { BusinessService } from '../business/business.service.js';
import { DevicesService } from '../devices/devices.service.js';
import { StaffService } from '../staff/staff.service.js';
import { RefreshTokensService } from '../sessions/refresh-tokens.service.js';
import { TokenService } from './token.service.js';

// Refresh rotation, logout and "who am I" (docs/phase-a-design.md sections 6 and 7).
@Injectable()
export class SessionService {
  constructor(
    private readonly identity: IdentityLookup,
    private readonly clock: Clock,
    private readonly tenants: TenantRunner,
    private readonly staff: StaffService,
    private readonly devices: DevicesService,
    private readonly business: BusinessService,
    private readonly tokens: TokenService,
    private readonly refreshTokens: RefreshTokensService,
  ) {}

  /**
   * Rotates a refresh token. The claim is one atomic statement, so of two
   * concurrent refreshes with the same token exactly one is CLAIMED. Reusing
   * a used token revokes its whole family (the strict rule Ian chose).
   */
  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const now = this.clock.now();
    const claim = await this.identity.claimRefreshToken(sha256(refreshToken), now);
    if (!claim) throw tokenInvalid();
    if (claim.outcome === 'EXPIRED') throw new ApiError(401, 'TOKEN_EXPIRED', 'Your session has expired. Please log in again.');
    if (claim.outcome === 'ALREADY_USED') {
      await this.tenants.run(claim.businessId, () => this.refreshTokens.revokeFamily(claim.familyId, now));
      // TODO(A5): audit "refresh token reuse detected".
      throw tokenInvalid();
    }
    if (claim.outcome !== 'CLAIMED') throw tokenInvalid();

    return this.tenants.run(claim.businessId, async () => {
      const membership = await this.staff.findForSession(claim.membershipId);
      if (!membership || membership.status !== 'ACTIVE') {
        throw new ApiError(403, 'MEMBERSHIP_INACTIVE', 'Your access to this business is not active.');
      }
      const device = await this.devices.findForSession(claim.deviceId);
      if (!device || device.status !== 'ACTIVE') {
        throw new ApiError(403, 'DEVICE_REVOKED', 'This device is no longer allowed. Please log in again.');
      }
      await this.devices.touchLastSeen(device.id, now);
      return this.tokens.issueSession(
        { personId: membership.personId, membershipId: membership.id, businessId: claim.businessId, deviceId: device.id },
        { familyId: claim.familyId },
      );
    });
  }

  /** Revokes every live refresh token of this membership on this device. Runs in the request's transaction. */
  async logout(auth: RequestAuth): Promise<void> {
    await this.refreshTokens.revokeForMembershipOnDevice(auth.membershipId, auth.deviceId, this.clock.now());
  }

  async me(session: RequestSession) {
    const business = await this.business.findCurrent();
    return {
      membership: {
        id: session.membership.id,
        display_name: session.membership.displayName,
        role_preset: session.membership.rolePreset,
        status: session.membership.status,
      },
      business: business ? { id: business.id, name: business.name, type: business.type } : null,
      device: { id: session.device.id, name: session.device.name, is_shared: session.device.isShared },
      permissions: [...session.permissions].sort(),
    };
  }
}

function tokenInvalid(): ApiError {
  return new ApiError(401, 'TOKEN_INVALID', 'Please log in again.');
}
