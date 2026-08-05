export const DEFAULT_CDP_EVALUATE_TIMEOUT_MS = 10_000;

export interface CdpEvaluateClient {
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  close(): void;
}

export async function evaluateCdpWithTimeout<T>(
  client: CdpEvaluateClient,
  expression: string,
  timeoutMs = DEFAULT_CDP_EVALUATE_TIMEOUT_MS,
): Promise<T> {
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      reject(new Error(`CDP Runtime.evaluate timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([
      client.send<{
        result?: { value?: T };
        exceptionDetails?: unknown;
      }>("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }),
      timeoutPromise,
    ]);
    if (result.exceptionDetails) {
      throw new Error(
        `renderer evaluation failed: ${JSON.stringify(result.exceptionDetails)}`,
      );
    }
    return result.result?.value as T;
  } catch (error) {
    if (timedOut) client.close();
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
