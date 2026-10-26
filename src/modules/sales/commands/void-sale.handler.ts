import { Injectable } from '@nestjs/common';
import type { CommandContext, CommandHandler } from '../../sync/command-handler.js';
import type { CommandOutcome } from '../../sync/command-outcome.js';
import { VoidSaleDto } from '../dto/void-sale.dto.js';
import { SalesService } from '../sales.service.js';
import { salesRejection } from './sales-rejection.js';

// sale.void (docs/phase-e-design.md sections 5 and 6). The dispatcher only
// requires sales.create (every preset), because a member without sales.void
// may void with a SALE_VOID approval (the stock.convert pattern of C5); the
// real check is in SalesService.void():
// - sales.void: void; any approval_id is ignored and not used;
// - otherwise an approval_id: use it (APPROVAL_INVALID when it cannot be used);
// - neither: PERMISSION_DENIED.
@Injectable()
export class VoidSaleHandler implements CommandHandler<VoidSaleDto> {
  readonly type = 'sale.void';
  readonly permission = 'sales.create';
  readonly payloadDto = VoidSaleDto;

  constructor(private readonly sales: SalesService) {}

  async handle(payload: VoidSaleDto, ctx: CommandContext): Promise<CommandOutcome> {
    try {
      const r = await this.sales.void(payload, {
        membershipId: ctx.actor.membershipId,
        deviceId: ctx.actor.deviceId,
        canVoid: ctx.actor.permissions.has('sales.void'),
        occurredAt: ctx.occurredAt,
        receivedAt: ctx.receivedAt,
        syncCommandId: ctx.syncCommandId,
      });
      return {
        status: 'ACCEPTED',
        data: { sale_id: r.saleId, voided_at: r.voidedAt.toISOString(), approved_by_membership_id: r.approvedByMembershipId },
      };
    } catch (err) {
      throw salesRejection(err);
    }
  }
}
