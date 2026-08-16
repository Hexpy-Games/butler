export class GuidedWorkCloseoutError extends Error {
  readonly code = "guided_work_closeout_persistence_failed";

  constructor(cause?: unknown) {
    super("Guided Work closeout could not persist an open disposition", {
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = "GuidedWorkCloseoutError";
  }
}

export function isGuidedWorkCloseoutError(
  error: unknown,
): error is GuidedWorkCloseoutError {
  return error instanceof GuidedWorkCloseoutError;
}
