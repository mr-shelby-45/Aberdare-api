import { Injectable } from '@nestjs/common';
import type { CommandContext, CommandHandler } from '../../sync/command-handler.js';
import type { CommandOutcome } from '../../sync/command-outcome.js';
import { CommandRejectedError } from '../../sync/command-rejected.error.js';
import { ConvertStockDto } from '../dto/convert-stock.dto.js';
import { StockCommandsService } from '../stock-commands.service.js';
import { rejectionFor } from './stock-rejection.js';

// stock.convert (docs/phase-c-design.md section 5). The dispatcher's check is
// only stock.view (every member has it), because from C5 an attendant without
// stock.convert may convert with a valid approval; the real check is here,
// after the payload is validated (decided in C4). A member with stock.convert
// converts and any approval_id is ignored, not consumed. Without it: refused
// until C5 adds the approval path.
@Injectable()
export class ConvertStockHandler implements CommandHandler<ConvertStockDto> {
  readonly type = 'stock.convert';
  readonly permission = 'stock.view';
  readonly payloadDto = ConvertStockDto;

  constructor(private readonly commands: StockCommandsService) {}

  async handle(payload: ConvertStockDto, ctx: CommandContext): Promise<CommandOutcome> {
    if (!ctx.actor.permissions.has('stock.convert')) {
      // The dispatcher's own wording for a missing permission.
      throw new CommandRejectedError('PERMISSION_DENIED', 'You are not allowed to do this');
    }
    try {
      const r = await this.commands.convert(payload, {
        membershipId: ctx.actor.membershipId,
        occurredAt: ctx.occurredAt,
        syncCommandId: ctx.syncCommandId,
      });
      return {
        status: 'ACCEPTED',
        data: {
          from_after: r.fromAfter,
          to_after: r.toAfter,
          units_added: r.unitsAdded,
          approved_by_membership_id: r.approvedByMembershipId,
        },
      };
    } catch (err) {
      throw rejectionFor(err);
    }
  }
}
