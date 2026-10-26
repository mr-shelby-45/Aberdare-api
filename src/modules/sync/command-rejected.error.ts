import type { ResultValue } from './command-outcome.js';

// An expected, permanent rejection of a command (bad input, missing
// permission, a business rule). It is stored, so a retry gets the same answer.
// data is sent to the phone as `result` (Phase C: the invalid lines).
export class CommandRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: Record<string, ResultValue>,
  ) {
    super(message);
    this.name = 'CommandRejectedError';
  }
}
