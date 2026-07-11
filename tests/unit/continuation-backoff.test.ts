import { expect, test } from "bun:test";
import { continuationBackoffForFailure } from "../../packages/butler-agent/src/interfaces/gateway/continuation-backoff.ts";

test("rate-limited continuations receive bounded exponential backoff", () => {
  const now = new Date("2026-07-11T00:00:00.000Z");

  expect(continuationBackoffForFailure({
    sourceErrorCode: "provider_rate_limited",
    retryStreak: 1,
    now,
  })).toEqual({
    delayMs: 15_000,
    notBefore: "2026-07-11T00:00:15.000Z",
  });
  expect(continuationBackoffForFailure({
    sourceErrorCode: "provider_rate_limited",
    retryStreak: 20,
    now,
  })).toEqual({
    delayMs: 300_000,
    notBefore: "2026-07-11T00:05:00.000Z",
  });
});

test("budget yields remain immediately eligible", () => {
  expect(continuationBackoffForFailure({
    sourceErrorCode: "prompt_usage_model_call_budget_exhausted",
    retryStreak: 4,
    now: new Date("2026-07-11T00:00:00.000Z"),
  })).toBeNull();
});
