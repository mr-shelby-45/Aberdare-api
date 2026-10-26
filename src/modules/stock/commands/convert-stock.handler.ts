import { Injectable } from '@nestjs/common';
import type { CommandContext, CommandHandler } from '../../sync/command-handler.js';
import type { CommandOutcome } from '../../sync/command-outcome.js';
import { CommandRejectedError } from '../../sync/command-rejected.error.js';
import { ConvertStockDto } from '../dto/convert-stock.dto.js';
import { StockCommandsService } from '../stock-commands.service.js';
import { rejectionFor } from './stock-rejection.js';

// stock.convert (docs/phase-c-design.md sections 5 and 6). The dispatcher's
// check is only stock.view (every member has it), because an attendant
// without stock.convert may convert with a valid approval; the real check is
// here, after the payload is validated (decided in C4):
// - stock.convert: convert; any approval_id is ignored and not consumed;
// - otherwise an approval_id: use it (APPROVAL_INVALID when it cannot be used);
// - neither: PERMISSION_DENIED.
@Injectable()
export class ConvertStockHandler implements CommandHandler<ConvertStockDto> {
  readonly type = 'stock.convert';
  readonly permission = 'stock.view';
  readonly payloadDto = ConvertStockDto;

  constructor(private readonly commands: StockCommandsService) {}

  async handle(payload: ConvertStockDto, ctx: CommandContext): Promise<CommandOutcome> {
    const canConvert = ctx.actor.permissions.has('stock.convert');
    if (!canConvert && payload.approval_id === undefined) {
      // The dispatcher's own wording for a missing permission.
      throw new CommandRejectedError('PERMISSION_DENIED', 'You are not allowed to do this');
    }
    try {
      const r = await this.commands.convert(
        payload,
        { membershipId: ctx.actor.membershipId, occurredAt: ctx.occurredAt, syncCommandId: ctx.syncCommandId },
        canConvert ? null : { approvalId: payload.approval_id!, deviceId: ctx.actor.deviceId, receivedAt: ctx.receivedAt },
      );
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
