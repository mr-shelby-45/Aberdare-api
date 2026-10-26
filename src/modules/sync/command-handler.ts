import type { CommandOutcome, SyncActor } from './command-outcome.js';

/** What a handler knows about the command beyond its payload. */
export interface CommandContext {
  actor: SyncActor;
  // When the phone says it happened (already checked: not more than 24 hours ahead).
  occurredAt: Date;
  // The claimed sync_command row (Phase C: movements point at it).
  syncCommandId: string;
  // When the server received it, from the Clock (Phase C5: approval time limits).
  receivedAt: Date;
}

// One command type from the phone (docs/architecture.md section 5). A handler
// runs inside the command's tenant transaction, in a savepoint. To reject a
// command it throws CommandRejectedError; any other error is treated as a crash.
export interface CommandHandler<TPayload extends object> {
  readonly type: string;
  // Checked by the dispatcher before the payload is even validated.
  readonly permission: string;
  readonly payloadDto: new () => TPayload;
  /**
   * Further permissions this particular payload needs, checked by the
   * dispatcher after validation (for example costs.view when it sets a cost price).
   */
  extraPermissions?(payload: TPayload): string[];
  handle(payload: TPayload, ctx: CommandContext): Promise<CommandOutcome>;
}
