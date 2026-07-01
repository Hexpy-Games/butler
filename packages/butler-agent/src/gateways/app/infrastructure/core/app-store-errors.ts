export class AppResponderTimeoutError extends Error {
  readonly code = "gateway_timeout";

  constructor(readonly timeoutMs: number) {
    super("Butler did not finish the turn before the app timeout.");
    this.name = "AppResponderTimeoutError";
  }
}

export class AppResponderCancelledError extends Error {
  readonly code = "turn_cancelled";

  constructor() {
    super("Butler turn was cancelled.");
    this.name = "AppResponderCancelledError";
  }
}

export class AppStoreOperationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppStoreOperationError";
  }
}
