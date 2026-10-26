import { Injectable } from '@nestjs/common';
import type { CommandContext, CommandHandler } from '../../sync/command-handler.js';
import type { CommandOutcome } from '../../sync/command-outcome.js';
import { CountStockDto } from '../dto/count-stock.dto.js';
import { StockCommandsService } from '../stock-commands.service.js';
import { rejectionFor } from './stock-rejection.js';

// stock.count (docs/phase-c-design.md section 5): a stock take. Needs
// stock.count. A count that leaves any counted pool below zero is still
// saved, as FLAGGED / NEGATIVE_AFTER_COUNT (the only FLAGGED in Phase C).
@Injectable()
export class CountStockHandler implements CommandHandler<CountStockDto> {
  readonly type = 'stock.count';
  readonly permission = 'stock.count';
  readonly payloadDto = CountStockDto;

  constructor(private readonly commands: StockCommandsService) {}

  async handle(payload: CountStockDto, ctx: CommandContext): Promise<CommandOutcome> {
    try {
      const r = await this.commands.count(payload, {
        membershipId: ctx.actor.membershipId,
        occurredAt: ctx.occurredAt,
        syncCommandId: ctx.syncCommandId,
      });
      const data = { lines: r.lines.map((l) => ({ pack_type_id: l.packTypeId, delta: l.delta, quantity_after: l.quantityAfter })) };
      return r.flagged
        ? { status: 'FLAGGED', code: 'NEGATIVE_AFTER_COUNT', message: 'The count was saved, but some stock is now below zero. Check it.', data }
        : { status: 'ACCEPTED', data };
    } catch (err) {
      throw rejectionFor(err);
    }
  }
}
