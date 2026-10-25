import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';

export interface MembershipSummary {
  id: string;
  businessId: string;
  personId: string;
  displayName: string;
  rolePreset: string;
  status: string;
}

@Injectable()
export class StaffRepository {
  async createOwner(personId: string, displayName: string, pinHash: string, now: Date): Promise<MembershipSummary> {
    return currentTx().membership.create({
      data: {
        businessId: currentBusinessId(),
        personId,
        displayName,
        rolePreset: 'OWNER',
        status: 'ACTIVE',
        pinHash,
        pinSetAt: now,
      },
      select: { id: true, businessId: true, personId: true, displayName: true, rolePreset: true, status: true },
    });
  }
}
