import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';
import type { AuditMetadata } from './audit.service.js';

@Injectable()
export class AuditRepository {
  /** Append only: app_user has no UPDATE or DELETE on audit_log. */
  async insert(entry: {
    actorMembershipId: string | null;
    action: string;
    targetType: string;
    targetId: string | null;
    metadata: AuditMetadata;
    ip: string | null;
    occurredAt: Date;
  }): Promise<void> {
    await currentTx().auditLog.create({
      data: { businessId: currentBusinessId(), ...entry, metadata: { ...entry.metadata } },
      select: { id: true },
    });
  }
}
