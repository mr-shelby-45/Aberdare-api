import type { CommandOutcome } from './command-outcome.js';

// One command type from the phone (docs/architecture.md section 5). A handler
// runs inside the command's tenant transaction, in a savepoint. To reject a
// command it throws CommandRejectedError; any other error is treated as a crash.
export interface CommandHandler<TPayload extends object> {
  readonly type: string;
  readonly permission: string;
  readonly payloadDto: new () => TPayload;
  handle(payload: TPayload): Promise<CommandOutcome>;
}
