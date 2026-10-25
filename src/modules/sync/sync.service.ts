import { Injectable } from '@nestjs/common';
import { Clock } from '../../common/time/clock.js';
import { validateDto } from '../../common/validation/validate-dto.js';
import { isForeignKeyViolation } from '../../database/db-errors.js';
import { TenantRunner, withSavepoint } from '../../database/tenant.js';
import { CatalogueHandlers } from './catalogue-handlers.js';
import type { CommandHandler } from './command-handler.js';
import type {
  CommandOutcome,
  CommandResult,
  SyncActor,
} from './command-outcome.js';
import { CommandRejectedError } from './command-rejected.error.js';
import { SyncCommandDto } from './dto/sync-command.dto.js';
import { SyncRepository } from './sync.repository.js';

// A phone clock may be a little ahead; more than this is a wrong clock or a
// forged time (docs/phase-b-design.md section 5). Any time in the past is fine.
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

// Processes phone commands exactly once each (docs/architecture.md section 5).
// Each command gets its own tenant transaction, so one bad command never
// undoes the others. Inside it:
//   1. claim the command row (INSERT ... ON CONFLICT DO NOTHING) first;
//      if it already exists, return the stored outcome;
//   2. decide: type, permission, occurred_at, payload validation, the
//      payload's extra permissions, handler (in a savepoint);
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
    handlers: CatalogueHandlers,
  ) {
    this.handlers = new Map(handlers.all.map((h) => [h.type, h]));
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
      // No valid envelope means nothing to store it under.
      return {
        commandId: null,
        status: 'REJECTED',
        code: 'VALIDATION_FAILED',
        message: 'The command is not valid',
      };
    }
    const commandId = envelope.command_id;
    const occurredAt = new Date(envelope.occurred_at);
    const receivedAt = this.clock.now();

    try {
      return await this.tenants.run(actor.businessId, async () => {
        const claimed = await this.repo.claim(commandId, envelope.type, occurredAt, receivedAt);
        if (!claimed) {
          return { commandId, ...(await this.repo.storedOutcome(commandId)) };
        }
        const outcome = await this.decide(actor, envelope, occurredAt, receivedAt);
        await this.repo.complete(commandId, outcome);
        return { commandId, ...outcome };
      });
    } catch (err) {
      // Everything for this command was rolled back, including its row. The
      // controller logs the type and error name; never the payload.
      return {
        commandId,
        status: 'FAILED',
        code: 'INTERNAL_ERROR',
        message: 'The command could not be processed. It will be retried.',
        failure: { type: envelope.type, errorName: err instanceof Error ? err.name : 'UnknownError' },
      };
    }
  }

  private async decide(
    actor: SyncActor,
    envelope: SyncCommandDto,
    occurredAt: Date,
    receivedAt: Date,
  ): Promise<CommandOutcome> {
    const handler = this.handlers.get(envelope.type);
    if (!handler) {
      return rejected('UNKNOWN_COMMAND_TYPE', 'This command type is not supported');
    }
    if (!actor.permissions.has(handler.permission)) {
      return rejected('PERMISSION_DENIED', 'You are not allowed to do this');
    }
    if (occurredAt.getTime() > receivedAt.getTime() + MAX_FUTURE_MS) {
      return rejected('OCCURRED_AT_INVALID', 'The time on this command is in the future. Check the phone clock.');
    }
    const payload = await validateDto(handler.payloadDto, envelope.payload);
    if (!payload) {
      return rejected('VALIDATION_FAILED', 'The command is not valid');
    }
    for (const permission of handler.extraPermissions?.(payload) ?? []) {
      if (!actor.permissions.has(permission)) {
        return rejected('PERMISSION_DENIED', 'You are not allowed to do this');
      }
    }
    try {
      return await withSavepoint(() => handler.handle(payload, { actor, occurredAt }));
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
