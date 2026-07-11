import { expect, test } from "bun:test";
import { homedir } from "node:os";
import {
  closeoutConfig,
  ledgerChecks,
  parseTrailingJson,
  runCloseoutCheck,
  validateCloseoutJson,
  type SpawnSyncLike,
} from "../support/gncc-closeout-runner.ts";

test("closeout config enforces GPT-5.6 Sol with low or medium reasoning", () => {
  expect(closeoutConfig({ model: "gpt-5.6-sol", reasoningEffort: "medium" })).toEqual({
    model: "openai/gpt-5.6-sol",
    reasoningEffort: "medium",
  });
  expect(() => closeoutConfig({ model: "openai/gpt-5.4", reasoningEffort: "low" }))
    .toThrow(/must use GPT-5\.6 Sol/);
  expect(() => closeoutConfig({ model: "openai/gpt-5.6-sol", reasoningEffort: "high" }))
    .toThrow(/reasoning must be low or medium/);
});

test("trailing JSON parser ignores noisy braces before the final object", () => {
  expect(parseTrailingJson([
    "warning: this line has {not-json}",
    "diagnostic: {\"partial\": true}",
    "{\"ok\":true,\"service\":\"fixture\",\"liveModelCalls\":2,\"data\":{\"nested\":true}}",
  ].join("\n"))).toEqual({
    ok: true,
    service: "fixture",
    liveModelCalls: 2,
    data: { nested: true },
  });
  expect(() => parseTrailingJson("no json here")).toThrow(/expected trailing JSON object/);
});

test("ledger checks are mandatory and include status plus check gates", () => {
  expect(() => {
    ledgerChecks({
      ledgerProject: "/missing/project-ledger/projects/butler",
      projectLedgerBin: "/repo/packages/project-ledger/bin/project-ledger",
      exists: () => false,
    });
  }).toThrow(/canonical Project Ledger project is required/);

  const checks = ledgerChecks({
    ledgerProject: "/ledger/butler",
    projectLedgerBin: "/repo/packages/project-ledger/bin/project-ledger",
    exists: () => true,
  });
  expect(checks.map((check) => check.name)).toEqual([
    "project-ledger-status",
    "project-ledger-check",
  ]);
  expect(checks.map((check) => check.validateJson)).toEqual([
    "project-ledger-status",
    "project-ledger-check",
  ]);
});

test("ledger JSON validators fail closed on stale status and check issues", () => {
  validateCloseoutJson("project-ledger-status", {
    ok: true,
    data: {
      issueCount: 0,
      staleViews: [],
      index: { stale: false },
    },
  });
  validateCloseoutJson("project-ledger-check", {
    ok: true,
    data: {
      ok: true,
      issueCount: 0,
    },
  });
  expect(() => {
    validateCloseoutJson("project-ledger-status", {
      ok: true,
      data: {
        issueCount: 0,
        staleViews: ["dashboard"],
        index: { stale: false },
      },
    });
  }).toThrow(/stale views/);
  expect(() => {
    validateCloseoutJson("project-ledger-check", {
      ok: true,
      data: {
        ok: false,
        issueCount: 1,
      },
    });
  }).toThrow(/check data failed/);
});

test("live E2E validator checks service, model, reasoning, and call count", () => {
  const valid = {
    ok: true,
    service: "live-service",
    model: "openai/gpt-5.6-sol",
    reasoningEffort: "low",
    liveModelCalls: 2,
  };
  validateCloseoutJson("live-e2e", valid, {
    service: "live-service",
    model: "openai/gpt-5.6-sol",
    reasoningEffort: "low",
    minLiveModelCalls: 2,
  });
  expect(() => {
    validateCloseoutJson("live-e2e", {
      ...valid,
      service: "wrong-service",
    }, {
      service: "live-service",
      model: "openai/gpt-5.6-sol",
      reasoningEffort: "low",
      minLiveModelCalls: 2,
    });
  }).toThrow(/service mismatch/);
  expect(() => {
    validateCloseoutJson("live-e2e", {
      ...valid,
      model: "openai/gpt-5.4",
    }, {
      service: "live-service",
      model: "openai/gpt-5.6-sol",
      reasoningEffort: "low",
    });
  }).toThrow(/model mismatch/);
  expect(() => {
    validateCloseoutJson("live-e2e", {
      ...valid,
      reasoningEffort: "high",
    }, {
      service: "live-service",
      model: "openai/gpt-5.6-sol",
      reasoningEffort: "low",
    });
  }).toThrow(/reasoning mismatch/);
});

test("runCloseoutCheck reports live calls and passes timeout to subprocesses", () => {
  let capturedTimeout = 0;
  const fakeSpawn: SpawnSyncLike = (_command, _args, options) => {
    capturedTimeout = options.timeout;
    return {
      status: 0,
      stdout: "setup log\n{\"ok\":true,\"service\":\"live-fixture\",\"model\":\"openai/gpt-5.6-sol\",\"reasoningEffort\":\"low\",\"liveModelCalls\":3}",
      stderr: "",
    };
  };
  let now = 10;
  const result = runCloseoutCheck({
    name: "live-fixture",
    cmd: ["bun", "run", "fixture.ts"],
    parseJson: true,
    validateJson: "live-e2e",
    expectedService: "live-fixture",
    expectedModel: "openai/gpt-5.6-sol",
    expectedReasoningEffort: "low",
    timeoutMs: 1234,
  }, {
    spawnSyncFn: fakeSpawn,
    now: () => {
      now += 5;
      return now;
    },
  });

  expect(capturedTimeout).toBe(1234);
  expect(result).toMatchObject({
    name: "live-fixture",
    ok: true,
    service: "live-fixture",
    liveModelCalls: 3,
    durationMs: 5,
  });
});

test("runCloseoutCheck redacts live tokens, secrets, and home paths from failures", () => {
  const liveToken = "LIVE_GNCC_SECRET_123456_private";
  const secret = "sk_1234567890abcdef";
  const fakeSpawn: SpawnSyncLike = () => ({
    status: null,
    error: new Error(`ETIMEDOUT ${secret}`),
    stdout: `${liveToken}\n${homedir()}/private/path`,
    stderr: secret,
  });

  let message = "";
  try {
    runCloseoutCheck({
      name: "stalled",
      cmd: ["bun", "run", "stalled.ts"],
      timeoutMs: 1,
    }, {
      spawnSyncFn: fakeSpawn,
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toContain("failed before completion");
  expect(message).not.toContain(liveToken);
  expect(message).not.toContain(secret);
  expect(message).not.toContain(homedir());
  expect(message).toContain("[redacted-live-token]");
});

test("validator failures redact parsed JSON diagnostics", () => {
  const liveToken = "LIVE_GNCC_SECRET_999999_private";
  const secret = "sk_abcdef1234567890";
  let message = "";
  try {
    validateCloseoutJson("live-e2e", {
      ok: false,
      service: "wrong-service",
      model: "openai/gpt-5.4",
      reasoningEffort: "high",
      liveModelCalls: 0,
      token: liveToken,
      secret,
      path: `${homedir()}/private/path`,
    }, {
      service: "live-service",
      model: "openai/gpt-5.6-sol",
      reasoningEffort: "low",
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toContain("live E2E reported failure");
  expect(message).not.toContain(liveToken);
  expect(message).not.toContain(secret);
  expect(message).not.toContain(homedir());
});
