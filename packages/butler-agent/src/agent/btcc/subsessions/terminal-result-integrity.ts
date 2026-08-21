/** A terminal result whose durable identity does not match its relation cannot be delivered. */
export class SubsessionTerminalResultIntegrityError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "SubsessionTerminalResultIntegrityError";
  }
}

export function terminalResultIntegrityFailure(code: string): never {
  throw new SubsessionTerminalResultIntegrityError(code);
}
