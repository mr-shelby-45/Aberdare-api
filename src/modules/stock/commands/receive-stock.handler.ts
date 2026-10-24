import { Injectable } from '@nestjs/common';
import type { CommandHandler } from '../../sync/command-handler.js';
import type { CommandOutcome } from '../../sync/command-outcome.js';
import { CommandRejectedError } from '../../sync/command-rejected.error.js';
import { StockQuantityChangeDto } from '../dto/stock-quantity-change.dto.js';
import { StockError } from '../stock.error.js';
import { StockService } from '../stock.service.js';

// stock.receive: goods arrived. Needs the stock.receive permission.
@Injectable()
export class ReceiveStockHandler
  implements CommandHandler<StockQuantityChangeDto>
{
  readonly type = 'stock.receive';
  readonly permission = 'stock.receive';
  readonly payloadDto = StockQuantityChangeDto;

  constructor(private readonly stock: StockService) {}

  async handle(payload: StockQuantityChangeDto): Promise<CommandOutcome> {
    try {
      const { quantity } = await this.stock.receive(
        payload.locationId,
        payload.packTypeId,
        payload.quantity,
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
