import { Injectable } from '@nestjs/common';
import type { CommandContext, CommandHandler } from '../../sync/command-handler.js';
import type { CommandOutcome } from '../../sync/command-outcome.js';
import { AdjustStockDto } from '../dto/adjust-stock.dto.js';
import { StockCommandsService } from '../stock-commands.service.js';
import { rejectionFor } from './stock-rejection.js';

// stock.adjust (docs/phase-c-design.md section 5): a correction with a
// reason. A decrease is strict. Needs stock.adjust.
@Injectable()
export class AdjustStockHandler implements CommandHandler<AdjustStockDto> {
  readonly type = 'stock.adjust';
  readonly permission = 'stock.adjust';
  readonly payloadDto = AdjustStockDto;

  constructor(private readonly commands: StockCommandsService) {}

  async handle(payload: AdjustStockDto, ctx: CommandContext): Promise<CommandOutcome> {
    try {
      const quantityAfter = await this.commands.adjust(payload, {
        membershipId: ctx.actor.membershipId,
        occurredAt: ctx.occurredAt,
        syncCommandId: ctx.syncCommandId,
      });
      return { status: 'ACCEPTED', data: { quantity_after: quantityAfter } };
    } catch (err) {
      throw rejectionFor(err);
    }
  }
}
