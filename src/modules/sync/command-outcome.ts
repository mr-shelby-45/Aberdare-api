/** A JSON value, for command results (Phase C: lists of lines). */
export type ResultValue = string | number | boolean | null | ResultValue[] | { [key: string]: ResultValue };

// What a command handler decides, stored in sync_command.result and returned
// unchanged to every caller that sends the same command again.
export interface CommandOutcome {
  status: 'ACCEPTED' | 'FLAGGED' | 'REJECTED';
  // Stable reason code for REJECTED (and FLAGGED), e.g. PERMISSION_DENIED.
  // Sent to the phone as `reason`.
  code?: string;
  // Safe to show to a user.
  message?: string;
  // Sent to the phone as `result`.
  data?: Record<string, ResultValue>;
}

// What processCommands returns per command. FAILED is never stored: the
// command was rolled back completely and the phone should send it again.
export interface CommandResult extends Omit<CommandOutcome, 'status'> {
  commandId: string | null;
  status: CommandOutcome['status'] | 'FAILED';
  // FAILED only, for the server log; never sent to the phone.
  failure?: { type: string; errorName: string; errorCode?: string };
}

// The identity the commands are processed for. All of it comes from the
// signed access token and the live session (CLAUDE.md rule 2), never from the body.
export interface SyncActor {
  businessId: string;
  membershipId: string;
  // The device of the access token (Phase C5: an approval is bound to it).
  deviceId: string;
  permissions: ReadonlySet<string>;
}
