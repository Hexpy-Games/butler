import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileToolHandlers } from "../../packages/butler-agent/src/agent/tools/file-tools/index.ts";
import { runCommandTool } from "../../packages/butler-agent/src/agent/tools/run-command/run_command/executor.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { bindQueuedInboundSession } from "../../packages/butler-agent/src/interfaces/gateway/btcc/queued-inbound-session-binder.ts";
import type { InboundEnvelope } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

test("general App ingress and file tools write data artifacts without a source workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-data-locality-"));
  const data = join(root, "data");
  const store = new SessionBindingStore(join(data, "runtime", "session-store.sqlite"));
  try {
    const envelope: InboundEnvelope = {
      eventId: "data-ingress", transport: "app", accountId: "default", peer: { kind: "dm", id: "general" },
      sender: { id: "user" }, message: { id: "message", text: "Create a report", timestamp: "2026-09-03T00:00:00Z" },
      routingHints: { sessionId: "butler/general" },
      executionControls: {
        schema_version: "butler.turn-execution-controls.v1", turn_id: "turn", session_id: "general",
        model_ref: "openai/gpt-5.5", access_mode: "full_access", reasoning_effort: "low", plan_mode: false,
        source: "session_override", session_control_revision: 1, catalog_generation: "test",
        resolved_at: "2026-09-03T00:00:00Z", model_fallback: { enabled: false, models: [] }, integrity_hash: "test",
      },
      appTurnContext: { version: 1, session: { id: "general", kind: "chat" },
        model: { requestedModelRef: "openai/gpt-5.5", reasoningEffort: "low" },
        conversation: { chatId: "general", userMessageId: "message", turnId: "turn", turnAttempt: 1 } },
    };
    bindQueuedInboundSession(envelope, store);
    expect(store.getBySessionId("butler/general")?.workspacePath).toBe(data);
    const handlers = createFileToolHandlers({ butlerData: data });
    const path = join(data, "artifacts", "generated", "report.md");
    const result = await handlers.write_file({ name: "write_file", rawArguments: "{}", args: { path, content: "report", overwrite: false, create_parents: true } });
    expect(result).toMatchObject({ ok: true });
    expect(readFileSync(path, "utf8")).toBe("report");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy general bindings relocate once, retaining identity and project bindings", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-binding-locality-"));
  const source = join(root, "source"), data = join(root, "data");
  const store = new SessionBindingStore(join(data, "runtime", "session-store.sqlite"));
  try {
    for (const role of ["butler", "steward", "worker"] as const) {
      store.upsert({ sessionId: role, role, workspacePath: source,
        runtimeAdapterId: "btcc-turn-runtime", modelProviderId: "openai", modelRef: "openai/gpt-5.5",
        transportBindings: [], metadata: { preserved: true } });
    }
    store.upsert({ sessionId: "project", role: "butler", projectId: "explicit-project", workspacePath: source,
      runtimeAdapterId: "btcc-turn-runtime", modelProviderId: "openai", modelRef: "openai/gpt-5.5", transportBindings: [] });
    const before = store.getBySessionId("worker")!;
    expect(store.relocateLegacyGeneralWorkspaces(source, data)).toBe(3);
    expect(store.getBySessionId("worker")).toEqual({ ...before, workspacePath: data });
    expect(store.getBySessionId("project")?.workspacePath).toBe(source);
    expect(store.relocateLegacyGeneralWorkspaces(source, data)).toBe(0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("file mutations reject a program directory even when it is bound as a workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-program-readonly-"));
  try {
    const handlers = createFileToolHandlers({ butlerHome: root, workspacePath: root });
    const result = await handlers.write_file({ name: "write_file", rawArguments: "{}", args: { path: "unwanted.md", content: "no", overwrite: false } });
    expect(result).toMatchObject({ ok: false });
    expect(existsSync(join(root, "unwanted.md"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin")("real command may read source and write data, but cannot write source by absolute path", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-command-readonly-"));
  const source = join(root, "source"), data = join(root, "data");
  mkdirSync(source); mkdirSync(data);
  writeFileSync(join(source, "read.txt"), "readable");
  const command = (text: string) => runCommandTool({ butlerHome: source, butlerData: data, workspacePath: data,
    args: { command: text, output_mode: "full" } });
  try {
    const allowed = await command(`cat "${source}/read.txt" > output.txt`);
    expect(allowed.ok).toBe(true);
    expect(readFileSync(join(data, "output.txt"), "utf8")).toBe("readable");
    const denied = await command(`printf unwanted > "${source}/unwanted.txt"`);
    expect(denied.ok).toBe(false);
    expect(existsSync(join(source, "unwanted.txt"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
