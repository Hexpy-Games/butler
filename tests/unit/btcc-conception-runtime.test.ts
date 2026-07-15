import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyConversationPromptContextPlan } from "../../packages/butler-agent/src/agent/context/conversation-context.ts";
import { buildConceptionContextEnvelope } from "../../packages/butler-agent/src/agent/turn/btcc/conception-runtime.ts";

let data = "";

beforeEach(() => {
  data = join(tmpdir(), `butler-btcc-conception-${Date.now()}-${Math.random()}`);
  mkdirSync(data, { recursive: true });
});

afterEach(() => rmSync(data, { recursive: true, force: true }));

test("project-bound Conception carries project hot-cache and Ledger refs as typed continuity", () => {
  const envelope = buildConceptionContextEnvelope({
    butlerData: data,
    turnId: "turn-project",
    userText: "버틀러의 BTCC 구현을 계속해줘.",
    inboundMessageRef: "message:turn-project",
    projectPolicy: {
      kind: "project_bound",
      projectId: "butler",
      ledgerProjectRef: "project-ledger:butler",
      workspaceRef: "/workspace/butler",
    },
    acceptedControlsRef: "controls:accepted",
    conversationContextPlan: emptyConversationPromptContextPlan("butler/project", 4096),
    promptSectionIds: [
      "hot_cache",
      "session_continuity",
      "project_memory",
      "project_hot_cache",
      "project_ledger_runtime_context",
      "active_work_state",
    ],
    capabilityManifest: [],
  });

  expect(envelope.projectPolicy.kind).toBe("project_bound");
  expect(envelope.continuity).toMatchObject({
    globalHotCacheRef: expect.stringContaining("prompt-section:"),
    sessionContinuityRef: expect.stringContaining("prompt-section:"),
    projectMemoryRef: expect.stringContaining("prompt-section:"),
    projectHotCacheRef: expect.stringContaining("prompt-section:"),
  });
  expect(envelope.projectContext).toMatchObject({
    ledgerRuntimeContextRef: expect.stringContaining("prompt-section:"),
    activeWorkStateRef: expect.stringContaining("prompt-section:"),
  });
  expect(envelope.continuity.projectHotCacheRef).not.toBe(
    envelope.continuity.projectMemoryRef,
  );
});
