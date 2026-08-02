export class GuidedCommandRejectedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GuidedCommandRejectedError";
    this.code = code;
  }
}
