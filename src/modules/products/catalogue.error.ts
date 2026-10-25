// An expected refusal of a catalogue change, with one of the reason codes of
// docs/phase-b-design.md section 5. Command handlers turn it into a REJECTED
// command; its message is shown to the user.
export class CatalogueError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogueError';
  }
}
