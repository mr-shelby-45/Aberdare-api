import { Injectable } from '@nestjs/common';
import { Clock } from '../../common/time/clock.js';
import { validateDto } from '../../common/validation/validate-dto.js';
import { isForeignKeyViolation } from '../../database/db-errors.js';
import { TenantRunner, withSavepoint } from '../../database/tenant.js';
import { AdjustStockHandler } from '../stock/commands/adjust-stock.handler.js';
import { ReceiveStockHandler } from '../stock/commands/receive-stock.handler.js';
import type { CommandHandler } from './command-handler.js';
import type {
  CommandOutcome,
  CommandResult,
  SyncActor,
} from './command-outcome.js';
import { CommandRejectedError } from './command-rejected.error.js';
import { SyncCommandDto } from './dto/sync-command.dto.js';
import { SyncRepository } from './sync.repository.js';

// Processes phone commands exactly once each (docs/architecture.md section 5).
// Each command gets its own tenant transaction, so one bad command never
// undoes the others. Inside it:
//   1. claim the command row (INSERT ... ON CONFLICT DO NOTHING) first;
//      if it already exists, return the stored outcome;
//   2. decide: permission, payload validation, handler (in a savepoint);
//   3. store the outcome on the row, then commit.
// An expected rejection is stored. An unexpected error rolls back the whole
// transaction, command row included, so the phone's retry runs it again
// (spike step 3, test 7; chosen by Ian).
@Injectable()
export class SyncService {
  private readonly handlers: ReadonlyMap<string, CommandHandler<object>>;

  constructor(
    private readonly tenants: TenantRunner,
    private readonly repo: SyncRepository,
    private readonly clock: Clock,
    receiveStock: ReceiveStockHandler,
    adjustStock: AdjustStockHandler,
  ) {
    this.handlers = new Map<string, CommandHandler<object>>(
      [receiveStock, adjustStock].map((h) => [h.type, h]),
    );
  }

  /** Commands are processed one at a time, in the order the phone sent them. */
  async processCommands(
    actor: SyncActor,
    commands: unknown[],
  ): Promise<CommandResult[]> {
    const results: CommandResult[] = [];
    for (const raw of commands) {
      results.push(await this.processOne(actor, raw));
    }
    return results;
  }

  private async processOne(
    actor: SyncActor,
    raw: unknown,
  ): Promise<CommandResult> {
    const envelope = await validateDto(SyncCommandDto, raw);
    if (!envelope) {
      // No valid command id means nothing to store it under.
      return {
        commandId: null,
        status: 'REJECTED',
        code: 'VALIDATION_FAILED',
        message: 'The command is not valid',
      };
    }
    const { commandId } = envelope;

    try {
      return await this.tenants.run(actor.businessId, async () => {
        const claimed = await this.repo.claim(commandId, envelope.type, new Date(envelope.occurredAt), this.clock.now());
        if (!claimed) {
          return { commandId, ...(await this.repo.storedOutcome(commandId)) };
        }
        const outcome = await this.decide(actor, envelope);
        await this.repo.complete(commandId, outcome);
        return { commandId, ...outcome };
      });
    } catch {
      // Everything for this command was rolled back, including its row.
      // TODO(step 5): log this through the project logger with the request ID.
      return {
        commandId,
        status: 'FAILED',
        code: 'INTERNAL_ERROR',
        message: 'The command could not be processed. It will be retried.',
      };
    }
  }

  private async decide(
    actor: SyncActor,
    envelope: SyncCommandDto,
  ): Promise<CommandOutcome> {
    const handler = this.handlers.get(envelope.type);
    if (!handler) {
      return rejected('UNKNOWN_COMMAND_TYPE', 'This command type is not supported');
    }
    if (!actor.permissions.has(handler.permission)) {
      return rejected('PERMISSION_DENIED', 'You are not allowed to do this');
    }
    const payload = await validateDto(handler.payloadDto, envelope.payload);
    if (!payload) {
      return rejected('VALIDATION_FAILED', 'The command is not valid');
    }
    try {
      return await withSavepoint(() => handler.handle(payload));
    } catch (err) {
      // The savepoint has already undone whatever the handler wrote.
      if (err instanceof CommandRejectedError) {
        return rejected(err.code, err.message);
      }
      if (isForeignKeyViolation(err)) {
        return rejected(
          'INVALID_REFERENCE',
          'The command refers to something that does not exist',
        );
      }
      throw err;
    }
  }
}

function rejected(code: string, message: string): CommandOutcome {
  return { status: 'REJECTED', code, message };
}
