export class OperationRejectedError extends Error {
  override readonly name = "OperationRejectedError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
