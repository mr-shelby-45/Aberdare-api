import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { currentTxIfAny } from './tenant.js';

/** One background failure for support (Phase F2). Codes and short ids only, never message text. */
export interface ErrorEventInput {
  // A job or component name, at most 60 characters.
  source: string;
  // An error code (a SQLSTATE or our own), at most 60 characters.
  code: string;
  // Short, no secrets; cut to 200 characters.
  detail?: string | null;
  businessId?: string | null;
}

// The only writer of error_event (docs/phase-f-design.md section 3). It is a
// support-only table with no RLS, so, like IdentityLookup, this lives in the
// database layer: inside a tenant transaction it writes in that transaction
// (and is rolled back with it); outside one, for failures that belong to no
// business, on its own connection. app_user may only INSERT the table, so the
// statement has no RETURNING. created_at is the database time, so this layer
// needs nothing from CoreModule (DatabaseModule stays self-contained).
@Injectable()
export class ErrorEventLog {
  constructor(private readonly prisma: PrismaService) {}

  async record(e: ErrorEventInput): Promise<void> {
    const client = currentTxIfAny() ?? this.prisma;
    await client.$executeRaw`
      INSERT INTO error_event (source, code, detail, business_id)
      VALUES (${clip(e.source, 60)}, ${clip(e.code, 60)}, ${e.detail ? clip(e.detail, 200) : null},
              ${e.businessId ?? null}::uuid)`;
  }
}

function clip(value: string, max: number): string {
  const v = value.trim();
  return v.length === 0 ? '?' : v.slice(0, max);
}
