import {
  AppResponderCancelledError,
  AppResponderTimeoutError,
} from "../core/app-store-errors.ts";
import type {
  AppMessageResponder,
  AppMessageResponderInput,
  AppMessageResponderResult,
} from "../../domain/sessions/message-responder-contract.ts";

export async function runResponderWithTimeout(
  responder: AppMessageResponder,
  input: Omit<AppMessageResponderInput, "signal">,
  timeoutMs?: number,
  externalSignal?: AbortSignal,
): Promise<AppMessageResponderResult> {
  const normalizedTimeoutMs = Number(timeoutMs);
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let removeExternalAbort: (() => void) | undefined;
  const abortController = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  const races: Array<Promise<AppMessageResponderResult> | Promise<never>> = [
    Promise.resolve(responder({ ...input, signal: controller.signal })),
  ];

  if (Number.isFinite(normalizedTimeoutMs) && normalizedTimeoutMs > 0) {
    races.push(
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          abortController();
          reject(new AppResponderTimeoutError(normalizedTimeoutMs));
        }, normalizedTimeoutMs);
      }),
    );
  }

  if (externalSignal) {
    races.push(
      new Promise<never>((_, reject) => {
        const abort = () => {
          abortController();
          reject(new AppResponderCancelledError());
        };
        if (externalSignal.aborted) {
          abort();
          return;
        }
        externalSignal.addEventListener("abort", abort, { once: true });
        removeExternalAbort = () =>
          externalSignal.removeEventListener("abort", abort);
      }),
    );
  }

  try {
    return await Promise.race(races);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    removeExternalAbort?.();
  }
}
