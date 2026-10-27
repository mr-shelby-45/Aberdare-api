import { Injectable } from '@nestjs/common';
import type { CommandContext, CommandHandler } from '../../sync/command-handler.js';
import type { CommandOutcome } from '../../sync/command-outcome.js';
import { CommandRejectedError } from '../../sync/command-rejected.error.js';
import { uniqueViolationConstraint } from '../../../database/db-errors.js';
import { CloseSettlementDto } from '../dto/close-settlement.dto.js';
import { FieldError } from '../field.error.js';
import { FieldService } from '../field.service.js';

// settlement.close (docs/phase-t-design.md section 6): a manager or owner
// (field.settle) closes a field attendant's day. Final once saved.
@Injectable()
export class CloseSettlementHandler implements CommandHandler<CloseSettlementDto> {
  readonly type = 'settlement.close';
  readonly permission = 'field.settle';
  readonly payloadDto = CloseSettlementDto;

  constructor(private readonly field: FieldService) {}

  async handle(payload: CloseSettlementDto, ctx: CommandContext): Promise<CommandOutcome> {
    try {
      const r = await this.field.close(payload, {
        membershipId: ctx.actor.membershipId,
        occurredAt: ctx.occurredAt,
        receivedAt: ctx.receivedAt,
        syncCommandId: ctx.syncCommandId,
      });
      return {
        status: 'ACCEPTED',
        data: { settlement_id: r.settlementId, cash_variance: r.cashVariance, lines: r.lines.map((l) => ({ pack_type_id: l.packTypeId, variance: l.variance })) },
      };
    } catch (err) {
      if (err instanceof FieldError) {
        throw new CommandRejectedError(err.code, err.message, err.invalidLines ? { invalid_lines: err.invalidLines.map((l) => ({ ...l })) } : undefined);
      }
      // Two closes with one settlement id at the same moment: the second hits the primary key.
      if (uniqueViolationConstraint(err) === 'field_settlement_pkey') {
        throw new CommandRejectedError('SETTLEMENT_ALREADY_EXISTS', 'This settlement was already closed.');
      }
      throw err;
    }
  }
}
