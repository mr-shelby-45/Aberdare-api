// An expected, permanent rejection of a command (bad input, missing
// permission, a business rule). It is stored, so a retry gets the same answer.
export class CommandRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CommandRejectedError';
  }
}
