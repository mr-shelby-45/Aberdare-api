import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

// The non-tenant maintenance path for change_log (Phase D1,
// docs/phase-d-design.md section 7). The prune covers every business at once,
// so it runs outside any tenant transaction, on its own connection, through
// the one SECURITY DEFINER function change_log_prune() (migration
// *_d1_change_log_prune). app_user has EXECUTE on it and no DELETE on
// change_log. Nothing calls this until Phase F schedules it.
@Injectable()
export class ChangeLogMaintenance {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Removes every change_log row written before `before` and moves the
   * horizon to the newest position removed. Returns how many rows went
   * (as text: a count is a bigint).
   */
  async prune(before: Date): Promise<string> {
    const rows = await this.prisma.$queryRaw<{ removed: string }[]>`
      SELECT change_log_prune(${before}::timestamptz)::text AS removed`;
    return rows[0].removed;
  }
}
