import { Injectable } from '@nestjs/common';
import { type MembershipSummary, StaffRepository } from './staff.repository.js';

@Injectable()
export class StaffService {
  constructor(private readonly repo: StaffRepository) {}

  /** The owner membership created at signup: ACTIVE, with the owner's PIN (already hashed). */
  async createOwner(personId: string, displayName: string, pinHash: string, now: Date): Promise<MembershipSummary> {
    return this.repo.createOwner(personId, displayName, pinHash, now);
  }
}
