import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAIQuotaAdapter } from
  "../../packages/butler-agent/src/integrations/providers/openai/provider-quota.ts";
import { mapOpenAICodexRateLimits } from
  "../../packages/butler-agent/src/integrations/providers/openai/codex-rate-limits.ts";
import { runCodexQuotaProcess } from
  "../../packages/butler-agent/src/integrations/providers/openai/codex-quota-process.ts";
import {
  createProviderQuotaMonitor,
  unavailableProviderQuota,
  type ProviderQuotaResult,
  type ProviderQuotaAdapter,
} from "../../packages/butler-agent/src/operations/metrics/provider-quota.ts";

function tempRoot(): string {
  const root = join(tmpdir(), `butler-provider-quota-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function freshResult(remainingPercent = 80): ProviderQuotaResult {
  return {
    available: true as const,
    stale: false as const,
    sourceKind: "provider_quota",
    sourceId: "test-source",
    planKind: "subscription" as const,
    planName: "Test",
    windows: [{
      id: "primary",
      usedPercent: 100 - remainingPercent,
      remainingPercent,
      windowDurationMins: 300,
      resetsAt: "2026-08-09T00:00:00.000Z",
      expiresAt: null,
    }],
    fetchedAt: "2026-08-09T00:00:00.000Z",
    reason: null,
  };
}

test("OpenAI parser prefers codex selected snapshot and clamps safe fields", () => {
  const mapped = mapOpenAICodexRateLimits({
    planType: "api-ignored-top-level",
    rateLimits: {
      primary: { usedPercent: 1, windowDurationMins: 1, resetsAt: 1 },
    },
    rateLimitsByLimitId: {
      codex: {
        planType: "Pro",
        primary: { usedPercent: 130, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: -10, resetsAt: null },
        individualLimit: { usedPercent: 50, remainingPercent: 120, resetsAt: 1_800_000_000, credits: 999 },
        credits: { usedPercent: 20, balance: 1234, resetCreditId: "secret" },
      },
    },
    accountId: "secret-account",
  });

  expect(mapped).toMatchObject({
    available: true,
    planKind: "subscription",
    planName: "Pro",
    windows: [
      { id: "primary", usedPercent: 100, remainingPercent: 0, windowDurationMins: 300 },
      { id: "secondary", usedPercent: 0, remainingPercent: 100 },
      {
        id: "individualLimit",
        usedPercent: 50,
        remainingPercent: 100,
        windowDurationMins: null,
        resetsAt: "2027-01-15T08:00:00.000Z",
      },
    ],
  });
  expect(JSON.stringify(mapped)).not.toContain("secret");
  expect(JSON.stringify(mapped)).not.toContain("1234");
  expect(mapped?.windows.some((window) => window.id === "credits")).toBe(false);
});

test("OpenAI adapter sends exact non-experimental app-server requests", async () => {
  const root = tempRoot();
  const prior = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CODEX_AUTH_JSON: process.env.CODEX_AUTH_JSON,
    CODEX_HOME: process.env.CODEX_HOME,
    BUTLER_CODEX_AUTH_PROFILE: process.env.BUTLER_CODEX_AUTH_PROFILE,
    BUTLER_OPENAI_AUTH_PROFILE: process.env.BUTLER_OPENAI_AUTH_PROFILE,
    BUTLER_DATA: process.env.BUTLER_DATA,
  };
  try {
    const codexHome = join(root, "codex");
    mkdirSync(codexHome, { recursive: true });
    const authPath = join(codexHome, "auth.json");
    writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "opaque" } }));
    delete process.env.OPENAI_API_KEY;
    delete process.env.BUTLER_CODEX_AUTH_PROFILE;
    delete process.env.BUTLER_OPENAI_AUTH_PROFILE;
    delete process.env.CODEX_AUTH_JSON;
    process.env.CODEX_HOME = codexHome;
    process.env.BUTLER_DATA = join(root, "butler");
    let request: {
      executable: string;
      arguments: readonly string[];
      stdin: string;
      followUpStdin?: string;
    } | undefined;
    const adapter = createOpenAIQuotaAdapter({
      executable: "/tmp/codex",
      runProcess: async (input) => {
        request = input;
        return {
        stdout: [
            JSON.stringify({ id: 1, result: {} }),
            JSON.stringify({
              id: 2,
              result: {
                rateLimits: { primary: { usedPercent: 5, windowDurationMins: 60 } },
              },
            }),
          ].join("\n"),
          exitCode: 0,
          timedOut: false,
          outputLimitExceeded: false,
          spawnError: false,
        };
      },
    });
    const result = await adapter.read();
    const initialize = request?.stdin.trim() ? JSON.parse(request.stdin) : null;
    const followUp = request?.followUpStdin?.trim().split("\n")
      .map((line) => JSON.parse(line));
    expect(request?.arguments).toEqual(["app-server", "--stdio"]);
    expect(initialize).toEqual({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "butler", version: "provider-quota" },
        capabilities: { experimentalApi: false },
      },
    });
    expect(followUp?.[0]).toEqual({ method: "initialized" });
    expect(followUp?.[1]).toEqual({ id: 2, method: "account/rateLimits/read" });
    expect(result.available).toBe(true);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenAI adapter classifies a safe app-server not-logged-in RPC error", async () => {
  const root = tempRoot();
  const prior = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CODEX_AUTH_JSON: process.env.CODEX_AUTH_JSON,
    CODEX_HOME: process.env.CODEX_HOME,
    BUTLER_CODEX_AUTH_PROFILE: process.env.BUTLER_CODEX_AUTH_PROFILE,
    BUTLER_DATA: process.env.BUTLER_DATA,
  };
  try {
    const codexHome = join(root, "codex");
    mkdirSync(codexHome, { recursive: true });
    const authPath = join(codexHome, "auth.json");
    writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "opaque" } }));
    delete process.env.OPENAI_API_KEY;
    delete process.env.BUTLER_CODEX_AUTH_PROFILE;
    delete process.env.CODEX_AUTH_JSON;
    process.env.CODEX_HOME = codexHome;
    process.env.BUTLER_DATA = join(root, "butler");
    const adapter = createOpenAIQuotaAdapter({
      executable: "/tmp/codex",
      runProcess: async () => ({
        stdout: JSON.stringify({
          id: 2,
          error: { code: -32000, message: "Not logged in", data: { token: "secret" } },
        }),
        exitCode: 0,
        timedOut: false,
        outputLimitExceeded: false,
        spawnError: false,
      }),
    });
    const result = await adapter.read();
    expect(result.reason?.code).toBe("provider_auth_failure");
    expect(JSON.stringify(result)).not.toContain("secret");
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenAI quota eligibility keeps API key and Butler profile surfaces unavailable", async () => {
  const prior = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CODEX_AUTH_JSON: process.env.CODEX_AUTH_JSON,
    BUTLER_CODEX_AUTH_PROFILE: process.env.BUTLER_CODEX_AUTH_PROFILE,
    BUTLER_OPENAI_AUTH_PROFILE: process.env.BUTLER_OPENAI_AUTH_PROFILE,
  };
  try {
    process.env.OPENAI_API_KEY = "sk-test";
    const apiKeyResult = await createOpenAIQuotaAdapter({
      resolveExecutable: () => { throw new Error("must not resolve executable"); },
    }).read();
    expect(apiKeyResult.reason?.code).toBe("provider_auth_not_applicable");

    delete process.env.OPENAI_API_KEY;
    process.env.BUTLER_CODEX_AUTH_PROFILE = "/tmp/profile.json";
    const profileResult = await createOpenAIQuotaAdapter({
      resolveExecutable: () => { throw new Error("must not resolve executable"); },
    }).read();
    expect(profileResult.reason?.code).toBe("provider_auth_surface_mismatch");
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("OpenAI API-key mode wins over an unrelated custom Codex auth path", async () => {
  const root = tempRoot();
  const prior = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CODEX_AUTH_JSON: process.env.CODEX_AUTH_JSON,
    CODEX_HOME: process.env.CODEX_HOME,
    BUTLER_CODEX_AUTH_PROFILE: process.env.BUTLER_CODEX_AUTH_PROFILE,
    BUTLER_OPENAI_AUTH_PROFILE: process.env.BUTLER_OPENAI_AUTH_PROFILE,
    BUTLER_DATA: process.env.BUTLER_DATA,
  };
  try {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.CODEX_AUTH_JSON = join(root, "unrelated-auth.json");
    delete process.env.CODEX_HOME;
    delete process.env.BUTLER_CODEX_AUTH_PROFILE;
    delete process.env.BUTLER_OPENAI_AUTH_PROFILE;
    process.env.BUTLER_DATA = join(root, "butler");
    let called = false;
    const result = await createOpenAIQuotaAdapter({
      executable: "/tmp/codex",
      runProcess: async () => {
        called = true;
        throw new Error("subprocess must not run for API-key mode");
      },
    }).read();
    expect(result.reason?.code).toBe("provider_auth_not_applicable");
    expect(called).toBe(false);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenAI quota rejects a non-canonical CODEX_AUTH_JSON path before subprocess", async () => {
  const root = tempRoot();
  const prior = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CODEX_AUTH_JSON: process.env.CODEX_AUTH_JSON,
    CODEX_HOME: process.env.CODEX_HOME,
    BUTLER_CODEX_AUTH_PROFILE: process.env.BUTLER_CODEX_AUTH_PROFILE,
    BUTLER_OPENAI_AUTH_PROFILE: process.env.BUTLER_OPENAI_AUTH_PROFILE,
    BUTLER_DATA: process.env.BUTLER_DATA,
  };
  try {
    const codexHome = join(root, "codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "opaque" } }));
    const customPath = join(root, "other-auth.json");
    writeFileSync(customPath, JSON.stringify({ tokens: { access_token: "other" } }));
    delete process.env.OPENAI_API_KEY;
    delete process.env.BUTLER_CODEX_AUTH_PROFILE;
    delete process.env.BUTLER_OPENAI_AUTH_PROFILE;
    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_AUTH_JSON = customPath;
    process.env.BUTLER_DATA = join(root, "butler");
    let called = false;
    const result = await createOpenAIQuotaAdapter({
      executable: "/tmp/codex",
      runProcess: async () => {
        called = true;
        throw new Error("subprocess must not run");
      },
    }).read();
    expect(result.reason?.code).toBe("provider_auth_surface_mismatch");
    expect(called).toBe(false);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider quota monitor isolates unsupported/failing providers and serves stale cache", async () => {
  let reads = 0;
  let fail = false;
  const adapter: ProviderQuotaAdapter = {
    providerId: "openai",
    async read() {
      reads += 1;
      if (fail) throw new Error("raw provider body must not escape");
      return freshResult();
    },
  };
  const monitor = createProviderQuotaMonitor({ adapters: [adapter] });
  const first = await monitor.refresh(["openai", "zai"]);
  expect(first.get("openai")?.available).toBe(true);
  expect(first.get("zai")?.reason?.code).toBe("provider_quota_surface_unavailable");
  fail = true;
  const second = await monitor.refresh(["openai"]);
  expect(second.get("openai")).toMatchObject({
    available: true,
    stale: true,
    fetchedAt: "2026-08-09T00:00:00.000Z",
    reason: { code: "provider_temporary_failure" },
  });
  expect(reads).toBe(2);
});

test("provider quota monitor clears cached quota across auth-boundary failures", async () => {
  let mode: "fresh" | "auth" | "temporary" = "fresh";
  const adapter: ProviderQuotaAdapter = {
    providerId: "openai",
    async read() {
      if (mode === "auth") {
        return unavailableProviderQuota({
          code: "provider_auth_failure",
          message: "safe auth failure",
        }, { kind: "codex_app_server", id: "openai-codex-rate-limits" });
      }
      if (mode === "temporary") throw new Error("temporary");
      return freshResult();
    },
  };
  const monitor = createProviderQuotaMonitor({ adapters: [adapter] });
  expect((await monitor.refreshProvider("openai")).available).toBe(true);
  mode = "auth";
  expect(await monitor.refreshProvider("openai")).toMatchObject({
    available: false,
    stale: false,
    windows: [],
    reason: { code: "provider_auth_failure" },
  });
  mode = "temporary";
  expect(await monitor.refreshProvider("openai")).toMatchObject({
    available: false,
    stale: false,
    windows: [],
    reason: { code: "provider_temporary_failure" },
  });
});

test("provider quota monitor deduplicates same-provider refreshes", async () => {
  let resolveRead: ((value: ReturnType<typeof freshResult>) => void) | undefined;
  let reads = 0;
  const adapter: ProviderQuotaAdapter = {
    providerId: "openai",
    read: () => {
      reads += 1;
      return new Promise((resolve) => { resolveRead = resolve; });
    },
  };
  const monitor = createProviderQuotaMonitor({ adapters: [adapter] });
  const left = monitor.refreshProvider("openai");
  const right = monitor.refreshProvider("openai");
  expect(reads).toBe(1);
  resolveRead?.(freshResult());
  expect((await Promise.all([left, right])).every((value) => value.available)).toBe(true);
});

test("codex process boundary resolves when a child ignores graceful termination", async () => {
  const started = Date.now();
  const result = await runCodexQuotaProcess({
    executable: process.execPath,
    arguments: ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
    stdin: "",
    timeoutMs: 30,
    maxOutputBytes: 1024,
  });
  expect(result.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(1_000);
});

test("codex process boundary performs the initialize handshake before rate limits", async () => {
  const childSource = [
    "const readline = require('node:readline');",
    "const rl = readline.createInterface({ input: process.stdin });",
    "let stage = 0;",
    "rl.on('line', (line) => {",
    "  const message = JSON.parse(line);",
    "  if (stage === 0 && message.id === 1) {",
    "    stage = 1;",
    "    process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');",
    "  } else if (stage === 1 && message.method === 'initialized') {",
    "    stage = 2;",
    "  } else if (stage === 2 && message.id === 2) {",
    "    process.stdout.write(JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 7 } } } }) + '\\n');",
    "  }",
    "});",
  ].join("\n");
  const result = await runCodexQuotaProcess({
    executable: process.execPath,
    arguments: ["-e", childSource],
    stdin: JSON.stringify({ id: 1, method: "initialize" }) + "\n",
    followUpStdin: JSON.stringify({ method: "initialized" }) + "\n" +
      JSON.stringify({ id: 2, method: "account/rateLimits/read" }) + "\n",
    timeoutMs: 1_000,
    maxOutputBytes: 4_096,
  });
  expect(result.timedOut).toBe(false);
  expect(result.outputLimitExceeded).toBe(false);
  expect(result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line).id)).toEqual([1, 2]);
});

test("codex process boundary preserves a multibyte response split across stdout chunks", async () => {
  const childSource = [
    "const readline = require('node:readline');",
    "const rl = readline.createInterface({ input: process.stdin });",
    "let stage = 0;",
    "rl.on('line', (line) => {",
    "  const message = JSON.parse(line);",
    "  if (stage === 0 && message.id === 1) {",
    "    stage = 1;",
    "    const response = Buffer.from(JSON.stringify({ id: 1, result: { message: '한' } }) + '\\n');",
    "    const split = response.indexOf(Buffer.from('한')) + 1;",
    "    process.stdout.write(response.subarray(0, split));",
    "    setTimeout(() => process.stdout.write(response.subarray(split)), 5);",
    "  } else if (stage === 1 && message.method === 'initialized') {",
    "    stage = 2;",
    "  } else if (stage === 2 && message.id === 2) {",
    "    process.stdout.write(JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 7 } } } }) + '\\n');",
    "  }",
    "});",
  ].join("\n");
  const result = await runCodexQuotaProcess({
    executable: process.execPath,
    arguments: ["-e", childSource],
    stdin: JSON.stringify({ id: 1, method: "initialize" }) + "\n",
    followUpStdin: JSON.stringify({ method: "initialized" }) + "\n" +
      JSON.stringify({ id: 2, method: "account/rateLimits/read" }) + "\n",
    timeoutMs: 1_000,
    maxOutputBytes: 4_096,
  });
  expect(result.timedOut).toBe(false);
  expect(result.spawnError).toBe(false);
  expect(result.stdout).toContain('"message":"한"');
  expect(result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line).id)).toEqual([1, 2]);
});

test("codex process boundary caps stdout and terminates the producer", async () => {
  const result = await runCodexQuotaProcess({
    executable: process.execPath,
    arguments: ["-e", "process.stdout.write('x'.repeat(100000)); setInterval(()=>{},1000)"],
    stdin: "",
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
  });
  expect(result.outputLimitExceeded).toBe(true);
  expect(result.stdout.length).toBeLessThanOrEqual(1_024);
});
