import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isTransientSessionReadError } from "./scenario-step.ts";

test("scenario evidence is built from the provider snapshot returned after cleanup", () => {
  const source = readFileSync(
    new URL("./scenario-runner.ts", import.meta.url),
    "utf8",
  );
  const cleanupStart = source.indexOf("let cleanupError: unknown;");
  const productStop = source.indexOf("await stopCurrent();", cleanupStart);
  const providerClose = source.indexOf(
    "providerRequests = await providerProxy.close();",
    cleanupStart,
  );
  const failureEvidence = source.indexOf(
    "const failure = failureEvidence({",
    cleanupStart,
  );
  const successEvidence = source.indexOf(
    "const evidence = successEvidence({",
    cleanupStart,
  );

  expect(cleanupStart).toBeGreaterThan(-1);
  expect(productStop).toBeGreaterThan(cleanupStart);
  expect(providerClose).toBeGreaterThan(productStop);
  expect(failureEvidence).toBeGreaterThan(providerClose);
  expect(successEvidence).toBeGreaterThan(providerClose);
  expect(source).not.toContain(
    "providerRequests: providerProxy.observations()",
  );
});

test("generic local session read failures are retryable while contract errors remain fatal", () => {
  expect(isTransientSessionReadError(new Error("Error: Request failed.")))
    .toBeTrue();
  expect(isTransientSessionReadError(new Error("fetch failed: ECONNREFUSED")))
    .toBeTrue();
  expect(isTransientSessionReadError(new Error("Bridge method is unavailable")))
    .toBeFalse();
});
