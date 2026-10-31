import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

// The 90-day purges of notification and error_event (Phase F5,
// docs/phase-f-design.md section 7). They cover every business at once, so
// they run outside any tenant transaction, through the SECURITY DEFINER
// functions of the f1_purge_functions migration (the ChangeLogMaintenance
// pattern). app_user has EXECUTE on them and no DELETE on either table.
@Injectable()
export class RetentionMaintenance {
  constructor(private readonly prisma: PrismaService) {}

  /** Deletes notifications created before `before`; returns the count (as text: a bigint). */
  async purgeNotifications(before: Date): Promise<string> {
    const rows = await this.prisma.$queryRaw<{ removed: string }[]>`SELECT purge_old_notifications(${before}::timestamptz)::text AS removed`;
    return rows[0].removed;
  }

  /** Deletes error events created before `before`; returns the count (as text). */
  async purgeErrorEvents(before: Date): Promise<string> {
    const rows = await this.prisma.$queryRaw<{ removed: string }[]>`SELECT purge_old_error_events(${before}::timestamptz)::text AS removed`;
    return rows[0].removed;
  }
}
