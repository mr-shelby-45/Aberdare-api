import { Injectable } from '@nestjs/common';
import type { CommandContext, CommandHandler } from '../../sync/command-handler.js';
import type { CommandOutcome } from '../../sync/command-outcome.js';
import { TransferStockDto } from '../dto/transfer-stock.dto.js';
import { StockCommandsService } from '../stock-commands.service.js';
import { rejectionFor } from './stock-rejection.js';

// stock.issue (docs/phase-t-design.md section 5): stock from a shop or warehouse to a field attendant's location. Needs stock.transfer
// (managers and owners).
@Injectable()
export class IssueStockHandler implements CommandHandler<TransferStockDto> {
  readonly type = 'stock.issue';
  readonly permission = 'stock.transfer';
  readonly payloadDto = TransferStockDto;

  constructor(private readonly commands: StockCommandsService) {}

  async handle(payload: TransferStockDto, ctx: CommandContext): Promise<CommandOutcome> {
    try {
      const r = await this.commands.transfer('ISSUE', payload, {
        membershipId: ctx.actor.membershipId,
        occurredAt: ctx.occurredAt,
        syncCommandId: ctx.syncCommandId,
      });
      return {
        status: 'ACCEPTED',
        data: { transfer_id: r.transferId, lines: r.lines.map((l) => ({ pack_type_id: l.packTypeId, from_after: l.fromAfter, to_after: l.toAfter })) },
      };
    } catch (err) {
      throw rejectionFor(err);
    }
  }
}
