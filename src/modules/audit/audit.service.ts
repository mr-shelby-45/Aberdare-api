import { Injectable } from '@nestjs/common';
import { currentRequestContext } from '../../common/context/request-context.js';
import { Clock } from '../../common/time/clock.js';
import { AuditRepository } from './audit.repository.js';

// Nested objects and arrays since Phase C2 (approved by Ian), for lists of
// lines such as [{ pack_type_id, quantity }]. Keys are checked at every level.
export type AuditValue = string | number | boolean | null | AuditValue[] | { [key: string]: AuditValue };
export type AuditMetadata = Record<string, AuditValue>;

// Metadata keys that suggest a secret or a full contact detail. A key like
// this is a programming mistake, so it throws (and rolls back the action)
// instead of quietly storing it. Values cannot be checked the same way, so
// callers only ever pass ids, enums, counts and flags.
const FORBIDDEN_KEY = /pin|otp|code|token|secret|password|hash|phone|email|key/i;
// Exact keys allowed despite matching above (approved by Ian in Phase B2): a
// product barcode is catalogue data, not a secret. "code" or "otp_code" are
// still refused.
const ALLOWED_KEYS: ReadonlySet<string> = new Set(['barcode', 'barcodes']);

export interface AuditEntry {
  // For example "staff.suspended".
  action: string;
  targetType: string;
  targetId: string | null;
  metadata?: AuditMetadata;
  // Leave out to use the request's actor; null for a system event.
  actorMembershipId?: string | null;
}

// Who did what, when (docs/phase-a-design.md section 14). Writes in the
// current tenant transaction, so the row commits or rolls back together with
// the change it records. Called by services only.
@Injectable()
export class AuditService {
  constructor(
    private readonly repo: AuditRepository,
    private readonly clock: Clock,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    const metadata = entry.metadata ?? {};
    checkKeys(metadata);
    const context = currentRequestContext();
    await this.repo.insert({
      actorMembershipId:
        entry.actorMembershipId !== undefined ? entry.actorMembershipId : (context?.actorMembershipId ?? null),
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      metadata,
      ip: context?.ip ?? null,
      occurredAt: this.clock.now(),
    });
  }
}

/** Refuses a suspicious key anywhere in the metadata, nested ones included. */
function checkKeys(value: AuditValue): void {
  if (Array.isArray(value)) {
    for (const item of value) checkKeys(item);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, inner] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key) && !ALLOWED_KEYS.has(key)) {
      throw new Error(`AuditService: metadata key "${key}" looks like a secret or contact detail`);
    }
    checkKeys(inner);
  }
}
