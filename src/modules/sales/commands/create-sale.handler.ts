import { Injectable } from '@nestjs/common';
import type { CommandContext, CommandHandler } from '../../sync/command-handler.js';
import type { CommandOutcome } from '../../sync/command-outcome.js';
import { CommandRejectedError } from '../../sync/command-rejected.error.js';
import { CreateSaleDto } from '../dto/create-sale.dto.js';
import { SalesError } from '../sales.error.js';
import { SalesService } from '../sales.service.js';

// sale.create (docs/phase-e-design.md section 5). Needs sales.create. A sale
// is saved whenever its input is valid: FLAGGED (still saved) when the phone's
// total differed or stock went below zero; the reason is the first flag.
@Injectable()
export class CreateSaleHandler implements CommandHandler<CreateSaleDto> {
  readonly type = 'sale.create';
  readonly permission = 'sales.create';
  readonly payloadDto = CreateSaleDto;

  constructor(private readonly sales: SalesService) {}

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
      if (err instanceof SalesError) {
        throw new CommandRejectedError(
          err.code,
          err.message,
          err.invalidLines ? { invalid_lines: err.invalidLines.map((l) => ({ line: l.line, reason: l.reason })) } : undefined,
        );
      }
      throw err;
    }
  }
}
