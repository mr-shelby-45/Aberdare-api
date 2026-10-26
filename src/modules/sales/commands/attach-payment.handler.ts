import { Injectable } from '@nestjs/common';
import type { CommandContext, CommandHandler } from '../../sync/command-handler.js';
import type { CommandOutcome } from '../../sync/command-outcome.js';
import { AttachPaymentDto } from '../dto/attach-payment.dto.js';
import { SalesService } from '../sales.service.js';
import { salesRejection } from './sales-rejection.js';

// payment.attach (docs/phase-e-design.md section 5). Needs payments.confirm.
// Members without sales.void attach only to their own sales (decided in E3,
// the same rule as the reads). FLAGGED (still saved) for a reused M-Pesa code
// or when the sale is now paid above its total.
@Injectable()
export class AttachPaymentHandler implements CommandHandler<AttachPaymentDto> {
  readonly type = 'payment.attach';
  readonly permission = 'payments.confirm';
  readonly payloadDto = AttachPaymentDto;

  constructor(private readonly sales: SalesService) {}

  async handle(payload: AttachPaymentDto, ctx: CommandContext): Promise<CommandOutcome> {
    try {
      const r = await this.sales.attachPayments(payload, {
        membershipId: ctx.actor.membershipId,
        seesAllSales: ctx.actor.permissions.has('sales.void'),
        occurredAt: ctx.occurredAt,
      });
      const data = { paid_total: r.paidTotal, balance_due: r.balanceDue, flags: r.flags };
      return r.flags.length > 0
        ? { status: 'FLAGGED', code: r.flags[0], message: 'The payments were saved. Some things need checking.', data }
        : { status: 'ACCEPTED', data };
    } catch (err) {
      throw salesRejection(err);
    }
  }
}
