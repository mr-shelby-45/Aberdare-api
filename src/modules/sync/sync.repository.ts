import { Injectable } from '@nestjs/common';
import { currentBusinessId, currentTx } from '../../database/tenant.js';
import type { CommandOutcome } from './command-outcome.js';

// sync_command SQL. Every method runs on the current tenant transaction.
@Injectable()
export class SyncRepository {
  /**
   * Claims a command as the very first write of its transaction. True means
   * this transaction owns it. False means it already exists: a concurrent
   * duplicate waits here on the unique index until the first transaction
   * commits (then false) or rolls back (then true).
   */
  async claim(commandId: string, type: string, occurredAt: Date, receivedAt: Date): Promise<boolean> {
    const rows = await currentTx().$queryRaw<{ id: string }[]>`
      INSERT INTO sync_command (business_id, command_id, type, status, occurred_at, received_at)
      VALUES (${currentBusinessId()}::uuid, ${commandId}::uuid, ${type}, 'PROCESSING',
              ${occurredAt}::timestamptz, ${receivedAt}::timestamptz)
      ON CONFLICT (business_id, command_id) DO NOTHING
      RETURNING id`;
    return rows.length === 1;
  }

  /** The stored outcome of a command that was already processed. */
  async storedOutcome(commandId: string): Promise<CommandOutcome> {
    const row = await currentTx().syncCommand.findUniqueOrThrow({
      where: {
        businessId_commandId: { businessId: currentBusinessId(), commandId },
      },
      select: { result: true },
    });
    // Written only by complete() below, so it has the CommandOutcome shape.
    return row.result as unknown as CommandOutcome;
  }

  /** PROCESSING -> outcome. The outcome_is_final policy blocks any later change. */
  async complete(commandId: string, outcome: CommandOutcome): Promise<void> {
    const { count } = await currentTx().syncCommand.updateMany({
      where: { commandId, status: 'PROCESSING' },
      data: { status: outcome.status, result: { ...outcome } },
    });
    if (count !== 1) {
      throw new Error(`sync_command ${commandId} was not PROCESSING`);
    }
  }
}
