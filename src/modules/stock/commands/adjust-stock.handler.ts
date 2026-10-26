import { Injectable } from '@nestjs/common';
import type { CommandContext, CommandHandler } from '../../sync/command-handler.js';
import type { CommandOutcome } from '../../sync/command-outcome.js';
import { CommandRejectedError } from '../../sync/command-rejected.error.js';
import { StockQuantityChangeDto } from '../dto/stock-quantity-change.dto.js';
import { StockError } from '../stock.error.js';
import { StockService } from '../stock.service.js';

// stock.adjust (spike version: decreases only, strict mode, so it can never
// go below zero). Needs the stock.adjust permission.
@Injectable()
export class AdjustStockHandler
  implements CommandHandler<StockQuantityChangeDto>
{
  readonly type = 'stock.adjust';
  readonly permission = 'stock.adjust';
  readonly payloadDto = StockQuantityChangeDto;

  constructor(private readonly stock: StockService) {}

  async handle(payload: StockQuantityChangeDto, ctx: CommandContext): Promise<CommandOutcome> {
    const movement = { occurredAt: ctx.occurredAt, createdByMembershipId: ctx.actor.membershipId, syncCommandId: ctx.syncCommandId };
    try {
      const { quantity } = await this.stock.decreaseStrict(
        payload.locationId,
        payload.packTypeId,
        payload.quantity,
        movement,
      );
      return { status: 'ACCEPTED', data: { quantity } };
    } catch (err) {
      if (err instanceof StockError) {
        throw new CommandRejectedError(err.code, err.message);
      }
      throw err;
    }
  }
}
