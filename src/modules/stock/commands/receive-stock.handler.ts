import { Injectable } from '@nestjs/common';
import type { CommandContext, CommandHandler } from '../../sync/command-handler.js';
import type { CommandOutcome } from '../../sync/command-outcome.js';
import { ReceiveStockDto } from '../dto/receive-stock.dto.js';
import { StockCommandsService } from '../stock-commands.service.js';
import { rejectionFor } from './stock-rejection.js';

// stock.receive (docs/phase-c-design.md section 5): one delivery. Needs
// stock.receive, and costs.view when any line carries unit_cost (even null),
// as for cost_price in Phase B.
@Injectable()
export class ReceiveStockHandler implements CommandHandler<ReceiveStockDto> {
  readonly type = 'stock.receive';
  readonly permission = 'stock.receive';
  readonly payloadDto = ReceiveStockDto;

  constructor(private readonly commands: StockCommandsService) {}

  extraPermissions(payload: ReceiveStockDto): string[] {
    return payload.lines.some((l) => l.unit_cost !== undefined) ? ['costs.view'] : [];
  }

  async handle(payload: ReceiveStockDto, ctx: CommandContext): Promise<CommandOutcome> {
    try {
      const lines = await this.commands.receive(payload, {
        membershipId: ctx.actor.membershipId,
        occurredAt: ctx.occurredAt,
        syncCommandId: ctx.syncCommandId,
      });
      return {
        status: 'ACCEPTED',
        data: { lines: lines.map((l) => ({ pack_type_id: l.packTypeId, quantity_after: l.quantityAfter })) },
      };
    } catch (err) {
      throw rejectionFor(err);
    }
  }
}
