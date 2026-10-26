import { Injectable } from '@nestjs/common';
import type { CommandContext, CommandHandler } from '../../sync/command-handler.js';
import type { CommandOutcome } from '../../sync/command-outcome.js';
import { CreateSaleDto } from '../dto/create-sale.dto.js';
import { SalesService } from '../sales.service.js';
import { salesRejection } from './sales-rejection.js';

// sale.create (docs/phase-e-design.md section 5). Needs sales.create, and
// payments.confirm as well when it carries payments. A sale is saved whenever
// its input is valid: FLAGGED (still saved) when the phone's total differed,
// stock went below zero, an M-Pesa code was used before or the payments
// exceed the total; the reason is the first flag.
@Injectable()
export class CreateSaleHandler implements CommandHandler<CreateSaleDto> {
  readonly type = 'sale.create';
  readonly permission = 'sales.create';
  readonly payloadDto = CreateSaleDto;

  constructor(private readonly sales: SalesService) {}

  extraPermissions(payload: CreateSaleDto): string[] {
    return payload.payments && payload.payments.length > 0 ? ['payments.confirm'] : [];
  }

  async handle(payload: CreateSaleDto, ctx: CommandContext): Promise<CommandOutcome> {
    try {
      const r = await this.sales.create(payload, {
        membershipId: ctx.actor.membershipId,
        deviceId: ctx.actor.deviceId,
        occurredAt: ctx.occurredAt,
        receivedAt: ctx.receivedAt,
        syncCommandId: ctx.syncCommandId,
      });
      const data = {
        sale_id: r.saleId,
        sale_number: r.saleNumber,
        total: r.total,
        paid_total: r.paidTotal,
        balance_due: r.balanceDue,
        flags: r.flags,
      };
      return r.flags.length > 0
        ? { status: 'FLAGGED', code: r.flags[0], message: 'The sale was saved. Some things need checking.', data }
        : { status: 'ACCEPTED', data };
    } catch (err) {
      throw salesRejection(err);
    }
  }
}
