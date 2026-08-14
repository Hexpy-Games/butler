export class PreparedButlerResourceError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Prepared Butler resource is unavailable: ${code}.`);
    this.name = "PreparedButlerResourceError";
    this.code = code;
  }
}
