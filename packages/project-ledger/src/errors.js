export class CliError extends Error {
  constructor(message, code = "invalid_arguments", exitCode = 2, details = null, next = []) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
    this.next = next;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function createEnvelope({ ok, command, data = null, error = null }) {
  return {
    ok,
    command,
    data: ok ? data : null,
    error,
    privacy: {
      rawTextIncluded: false,
      secretsIncluded: false,
    },
  };
}

export function errorFromUnknown(error) {
  return error instanceof CliError
    ? error
    : new CliError(error instanceof Error ? error.message : "Unknown error", "internal_error", 1);
}
