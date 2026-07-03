import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVELOPER_LOG_MAX_ENTRIES,
  DeveloperLogStore,
} from "../../packages/butler-agent/src/operations/diagnostics/developer-log-store.ts";

let tempDir = "";

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

function createStore() {
  tempDir = mkdtempSync(join(tmpdir(), "butler-devlog-"));
  return new DeveloperLogStore({ butlerData: tempDir });
}

function appendSample(store: DeveloperLogStore, index = 0) {
  return store.appendModelTurn({
    binding: {
      sessionId: `session-${index}`,
      role: "butler",
      workspacePath: process.cwd(),
      runtimeAdapterId: "runtime",
      modelProviderId: "provider",
      modelRef: "provider/model",
      transportBindings: [],
      lifecycleState: "active",
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
    },
    envelope: {
      eventId: `event-${index}`,
      transport: "app",
      accountId: "local",
      peer: { kind: "dm", id: "general" },
      sender: { id: "user" },
      message: {
        id: `message-${index}`,
      text: `OPENAI_API_KEY=secret-${index}`,
        timestamp: "2026-07-02T00:00:00.000Z",
      },
      routingHints: { turnId: `turn-${index}` },
    },
    contextAssembly: {
      staticContext: [],
      liveConfiguration: [],
      runtimeState: [{
        id: "runtime-state",
        title: "Runtime State",
        region: "runtime_state",
        content: `Authorization: Bearer opaque-${index}\npassword=hunter-${index}`,
      }],
      workingContext: [],
      retrievedContext: [],
      currentInput: [],
      references: [],
      liveConfigHash: "hash",
    },
    promptContext: `api_key: sk-${index}\naccess_token=token-${index}`,
    result: {
      text: `answer ${index} Bearer response-${index}`,
      raw: {
        ok: true,
        api_key: `secret-${index}`,
      },
    },
    timestamp: `2026-07-02T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
  });
}

test("developer log store redacts obvious secrets and filters entries", () => {
  const store = createStore();
  appendSample(store, 1);

  const result = store.list({ query: "provider/model" });
  expect(result.total).toBe(1);
  expect(store.list({ query: "Runtime State" }).total).toBe(1);
  expect(store.list({ query: "OPENAI_API_KEY" }).total).toBe(0);
  expect(result.entries[0]?.request.input_text).toContain("[REDACTED]");
  expect(result.entries[0]?.context.prompt_context).toContain("[REDACTED]");
  expect(result.entries[0]?.context.prompt_context).not.toContain("sk-1");
  expect(result.entries[0]?.context.prompt_context).not.toContain("token-1");
  expect(result.entries[0]?.context.sections[0]?.content).toContain("[REDACTED]");
  expect(result.entries[0]?.context.sections[0]?.content).not.toContain("hunter-1");
  expect(result.entries[0]?.response.text).toContain("[REDACTED]");
  expect(result.entries[0]?.response.text).not.toContain("response-1");
  expect(result.entries[0]?.response.raw).toMatchObject({
    api_key: "[REDACTED]",
  });
  const path = join(tempDir, "app", "developer-logs", "model-turns.jsonl");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(tempDir, "app", "developer-logs")).mode & 0o777).toBe(0o700);
});

test("developer log store appends failed model turns with safe diagnostics", () => {
  const store = createStore();
  store.appendModelTurnError({
    kind: "model_turn_error",
    binding: {
      sessionId: "session-error",
      role: "butler",
      workspacePath: process.cwd(),
      runtimeAdapterId: "runtime",
      modelProviderId: "provider",
      modelRef: "provider/model",
      transportBindings: [],
      lifecycleState: "active",
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
    },
    envelope: {
      eventId: "event-error",
      transport: "app",
      accountId: "local",
      peer: { kind: "dm", id: "general" },
      sender: { id: "user" },
      message: {
        id: "message-error",
        text: "hello api_key=secret",
        timestamp: "2026-07-02T00:00:00.000Z",
      },
      routingHints: { turnId: "turn-error" },
    },
    contextAssembly: {
      staticContext: [],
      liveConfiguration: [],
      runtimeState: [{
        id: "runtime-state",
        title: "Runtime State",
        region: "runtime_state",
        content: "Authorization: Bearer hidden",
      }],
      workingContext: [],
      retrievedContext: [],
      currentInput: [],
      references: [],
      liveConfigHash: "hash-error",
    },
    promptContext: "Authorization: Bearer hidden",
    failure: {
      code: "provider_rate_limited",
      message: "Provider returned HTTP 429",
      statusCode: 429,
      retryable: true,
      cause: "OPENAI_API_KEY=secret",
    },
    diagnostics: {
      api_key: "secret",
    },
    timestamp: "2026-07-02T00:00:02.000Z",
  });

  const result = store.list({ kind: "model_turn_error", query: "provider_rate_limited" });
  expect(result.total).toBe(1);
  expect(result.entries[0]).toMatchObject({
    kind: "model_turn_error",
    session_id: "session-error",
    turn_id: "turn-error",
    response: {
      text: "Provider returned HTTP 429",
      raw: {
        failure: {
          code: "provider_rate_limited",
          statusCode: 429,
          retryable: true,
        },
        diagnostics: {
          api_key: "[REDACTED]",
        },
      },
    },
  });
  expect(result.entries[0]?.request.input_text).toContain("[REDACTED]");
  expect(result.entries[0]?.context.prompt_context).toContain("[REDACTED]");
  expect(JSON.stringify(result.entries[0]?.response.raw)).not.toContain("secret");
});

test("developer log store skips corrupt lines and keeps newest bounded entries", () => {
  const store = createStore();
  const path = join(tempDir, "app", "developer-logs", "model-turns.jsonl");
  appendSample(store, 0);
  writeFileSync(path, "not-json\n", { flag: "a" });
  writeFileSync(path, `${JSON.stringify({
    schema: "butler.developer-log.v1",
    kind: "model_turn",
  })}\n`, { flag: "a" });
  appendSample(store, 1);

  expect(store.list().total).toBe(2);

  for (let index = 2; index < DEVELOPER_LOG_MAX_ENTRIES + 8; index += 1) {
    appendSample(store, index);
  }

  const bounded = store.list({ limit: 100 });
  expect(bounded.total).toBe(DEVELOPER_LOG_MAX_ENTRIES);
  expect(bounded.entries.some((entry) => entry.turn_id === "turn-0")).toBe(false);
});
