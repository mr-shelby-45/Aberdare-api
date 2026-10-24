// What a command handler decides, stored in sync_command.result and returned
// unchanged to every caller that sends the same command again.
export interface CommandOutcome {
  status: 'ACCEPTED' | 'FLAGGED' | 'REJECTED';
  // Stable reason code for REJECTED (and FLAGGED), e.g. PERMISSION_DENIED.
  code?: string;
  // Safe to show to a user.
  message?: string;
  data?: Record<string, string | number | boolean>;
}

// What processCommands returns per command. FAILED is never stored: the
// command was rolled back completely and the phone should send it again.
export interface CommandResult extends Omit<CommandOutcome, 'status'> {
  commandId: string | null;
  status: CommandOutcome['status'] | 'FAILED';
}

// The identity the commands are processed for. Both fields will come from the
// signed access token (CLAUDE.md rule 2); the spike passes them in directly.
export interface SyncActor {
  businessId: string;
  permissions: ReadonlySet<string>;
}
