import { Injectable } from '@nestjs/common';
import { type BusinessType, BusinessRepository } from './business.repository.js';

@Injectable()
export class BusinessService {
  constructor(private readonly repo: BusinessRepository) {}

  /**
   * Creates the business whose id is the current tenant. Run inside
   * TenantRunner.run(newBusinessId); the business RLS policy rejects any
   * other id.
   */
  async createForSignup(name: string, type: BusinessType): Promise<void> {
    await this.repo.create(name, type);
  }

  async findCurrent(): Promise<{ id: string; name: string; type: BusinessType } | null> {
    return this.repo.findCurrent();
  }
}
