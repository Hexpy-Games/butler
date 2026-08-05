import { expect, test } from "bun:test";
import { evaluateCdpWithTimeout } from "./cdp-timeout.ts";

test("Runtime.evaluate command timeout closes the CDP client", async () => {
  let closed = false;
  const client = {
    send: async () => await new Promise<never>(() => undefined),
    close: () => {
      closed = true;
    },
  };
  await expect(
    evaluateCdpWithTimeout(client, "await new Promise(() => {})", 10),
  ).rejects.toThrow("Runtime.evaluate timed out");
  expect(closed).toBe(true);
});

test("Runtime.evaluate returns by-value results and surfaces renderer exceptions", async () => {
  const client = {
    send: async <T>() => ({ result: { value: { ok: true } } } as T),
    close: () => undefined,
  };
  await expect(evaluateCdpWithTimeout(client, "1 + 1", 50)).resolves.toEqual({ ok: true });
  const failingClient = {
    send: async <T>() => ({ exceptionDetails: { text: "boom" } } as T),
    close: () => undefined,
  };
  await expect(evaluateCdpWithTimeout(failingClient, "throw new Error()", 50))
    .rejects.toThrow("renderer evaluation failed");
});
