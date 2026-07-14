import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitContinuityUpdates,
  ContinuityStore,
  type ContinuityProvenance,
} from "../../packages/butler-agent/src/agent/cognition/continuity/continuity-store.ts";
import { PromptAssembler } from "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import type { StoredSessionBinding } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import {
  compileStructuredTurnDecision,
  parseStructuredTurnDecision,
} from "../../packages/butler-agent/src/agent/turn/native/turn-runner/typed-turn-decision.ts";
import { activateTurnContract } from "../../packages/butler-agent/src/agent/turn/native/turn-runner/turn-contract-runtime.ts";
import type { ToolSurfacePromptController } from "../../packages/butler-agent/src/agent/turn/tool-surface-prompt-controller.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(): { root: string; data: string; projectA: string; projectB: string } {
  const root = mkdtempSync(join(tmpdir(), "butler-continuity-"));
  roots.push(root);
  const data = join(root, "data");
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  mkdirSync(data, { recursive: true });
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  writeFileSync(join(data, "butler.config.json"), JSON.stringify({
    projects: [
      { name: "project-a", path: projectA },
      { name: "project-b", path: projectB },
    ],
  }));
  return { root, data, projectA, projectB };
}

function provenance(overrides: Partial<ContinuityProvenance> = {}): ContinuityProvenance {
  return {
    conversation_session_id: "cs-project-a",
    turn_id: "turn-1",
    inbound_message_id: "message-1",
    runtime_session_id: "butler/project-a",
    project_id: "project-a",
    ...overrides,
  };
}

test("one typed model decision commits generic project continuity before delivery and replay is idempotent", () => {
  const { data, projectA, projectB } = fixture();
  const decision = parseStructuredTurnDecision(JSON.stringify({
    schema_version: "butler.turn-contract-decision.v1",
    decision_id: "decision-continuity-1",
    action: "answer",
    target_workstream_id: null,
    target_project_id: null,
    blocker_id: null,
    evidence_domain: null,
    inspection_scope: null,
    deliverables: [],
    continuity_updates: [{
      scope: "project",
      kind: "instruction",
      operation: "upsert",
      summary: "Use the project-managed jump host procedure for remote maintenance.",
      target_ref: null,
    }],
    answer_text: "확인했습니다.",
    public_title: "지침 반영",
    public_summary: "프로젝트 운영 지침을 반영합니다.",
    public_rationale: "다음 작업의 연속성을 유지합니다.",
    immediate_next_step: null,
  }), "decision-continuity-1");
  const contract = compileStructuredTurnDecision({
    decision,
    candidates: {},
    workspaceId: "project-a",
    projectId: "project-a",
    continuityCandidates: [],
  });
  const activation = () => activateTurnContract({
    butlerData: data,
    contract,
    decision,
    sessionId: "butler/project-a",
    projectId: "project-a",
    turnId: "turn-1",
    continuityCandidates: [],
    continuityProvenance: provenance(),
    boundWorkspacePath: projectA,
    toolSurfaceController: { applyTurnMetadata() {} } as unknown as ToolSurfacePromptController,
  });

  activation();
  activation();

  const projectCache = readFileSync(join(projectA, ".butler", "hot-cache.md"), "utf8");
  expect(projectCache.match(/project-managed jump host procedure/gu)).toHaveLength(1);
  expect(projectCache).toContain("conversation=cs-project-a; turn=turn-1; message=message-1");
  expect(existsSync(join(projectB, ".butler", "hot-cache.md"))).toBe(false);
  const store = new ContinuityStore(data);
  expect(store.listCandidates({ projectId: "project-a", sessionId: "butler/project-a" })).toHaveLength(1);
  store.close();
});

test("supersede and forget require an active bounded candidate and update only its owner", () => {
  const { data, projectA } = fixture();
  const first = commitContinuityUpdates({
    butlerData: data,
    decisionId: "decision-a",
    updates: [{
      scope: "project",
      kind: "constraint",
      operation: "upsert",
      summary: "Deploy from the signed release branch only.",
    }],
    candidateRefs: [],
    provenance: provenance(),
    boundWorkspacePath: projectA,
  })[0]!;
  expect(() => commitContinuityUpdates({
    butlerData: data,
    decisionId: "decision-unknown",
    updates: [{
      scope: "project",
      kind: "constraint",
      operation: "forget",
      summary: "Remove an obsolete deployment constraint.",
      target_ref: "cu_unknown",
    }],
    candidateRefs: ["cu_unknown"],
    provenance: provenance({ turn_id: "turn-2", inbound_message_id: "message-2" }),
    boundWorkspacePath: projectA,
  })).toThrow("continuity_target_not_active");

  const replacement = commitContinuityUpdates({
    butlerData: data,
    decisionId: "decision-b",
    updates: [{
      scope: "project",
      kind: "constraint",
      operation: "supersede",
      summary: "Deploy only from a signed and reviewed release branch.",
      target_ref: first.continuity_id,
    }],
    candidateRefs: [first.continuity_id],
    provenance: provenance({ turn_id: "turn-2", inbound_message_id: "message-2" }),
    boundWorkspacePath: projectA,
  })[0]!;
  const body = readFileSync(join(projectA, ".butler", "hot-cache.md"), "utf8");
  expect(body).not.toContain("Deploy from the signed release branch only.");
  expect(body).toContain("signed and reviewed release branch");

  commitContinuityUpdates({
    butlerData: data,
    decisionId: "decision-c",
    updates: [{
      scope: "project",
      kind: "constraint",
      operation: "forget",
      summary: "The release-branch constraint no longer applies.",
      target_ref: replacement.continuity_id,
    }],
    candidateRefs: [replacement.continuity_id],
    provenance: provenance({ turn_id: "turn-3", inbound_message_id: "message-3" }),
    boundWorkspacePath: projectA,
  });
  expect(readFileSync(join(projectA, ".butler", "hot-cache.md"), "utf8"))
    .not.toContain("signed and reviewed release branch");
});

test("failed supersede destination remains retryable and hides pending state", () => {
  const { data, projectA } = fixture();
  const first = commitContinuityUpdates({
    butlerData: data,
    decisionId: "decision-pending-first",
    updates: [{
      scope: "project",
      kind: "constraint",
      operation: "upsert",
      summary: "Publish only after the compatibility suite passes.",
    }],
    candidateRefs: [],
    provenance: provenance(),
    boundWorkspacePath: projectA,
  })[0]!;
  writeFileSync(
    join(data, "butler.config.json"),
    JSON.stringify({ projects: [] }),
  );
  const replacement = {
    scope: "project" as const,
    kind: "constraint" as const,
    operation: "supersede" as const,
    summary: "Publish only after compatibility and rollback suites pass.",
    target_ref: first.continuity_id,
  };
  const replayInput = {
    butlerData: data,
    decisionId: "decision-pending-replacement",
    updates: [replacement],
    candidateRefs: [first.continuity_id],
    provenance: provenance({
      turn_id: "turn-pending",
      inbound_message_id: "message-pending",
    }),
  };

  expect(() => commitContinuityUpdates(replayInput)).toThrow(
    "continuity_project_workspace_unresolved",
  );
  const pendingStore = new ContinuityStore(data);
  expect(
    pendingStore.listCandidates({
      projectId: "project-a",
      sessionId: "butler/project-a",
    }),
  ).toEqual([
    expect.objectContaining({
      continuity_id: first.continuity_id,
      summary: "Publish only after the compatibility suite passes.",
    }),
  ]);
  pendingStore.close();

  writeFileSync(
    join(data, "butler.config.json"),
    JSON.stringify({ projects: [{ name: "project-a", path: projectA }] }),
  );
  const recovered = commitContinuityUpdates(replayInput)[0]!;
  expect(recovered.operation).toBe("supersede");
  expect(readFileSync(join(projectA, ".butler", "hot-cache.md"), "utf8"))
    .toContain("compatibility and rollback suites");
  const recoveredStore = new ContinuityStore(data);
  expect(
    recoveredStore.listCandidates({
      projectId: "project-a",
      sessionId: "butler/project-a",
    }),
  ).toEqual([
    expect.objectContaining({
      continuity_id: recovered.continuity_id,
      summary: "Publish only after compatibility and rollback suites pass.",
    }),
  ]);
  recoveredStore.close();
});

test("session, global correction, and global preference route to their explicit owners", () => {
  const { data } = fixture();
  const sessionReceipt = commitContinuityUpdates({
    butlerData: data,
    decisionId: "decision-session",
    updates: [{
      scope: "session",
      kind: "working_state",
      operation: "upsert",
      summary: "The migration audit is paused after validating batch three.",
    }],
    candidateRefs: [],
    provenance: provenance(),
  })[0]!;
  const correction = commitContinuityUpdates({
    butlerData: data,
    decisionId: "decision-correction",
    updates: [{
      scope: "global",
      kind: "correction",
      operation: "upsert",
      summary: "Do not treat UI labels as proof of the executed runtime model.",
    }],
    candidateRefs: [],
    provenance: provenance({ turn_id: "turn-2", inbound_message_id: "message-2" }),
  })[0]!;
  const preference = commitContinuityUpdates({
    butlerData: data,
    decisionId: "decision-preference",
    updates: [{
      scope: "global",
      kind: "preference",
      operation: "upsert",
      summary: "Review runtime designs by simulating the concrete call path.",
    }],
    candidateRefs: [],
    provenance: provenance({ turn_id: "turn-3", inbound_message_id: "message-3" }),
  })[0]!;

  expect(sessionReceipt.destination).toBe("session_continuity");
  expect(correction.destination).toBe("feedback_buffer");
  expect(preference.destination).toBe("explicit_global_rule");
  expect(readFileSync(join(data, "cognition", "feedback", "feedback.md"), "utf8"))
    .toContain("UI labels as proof");
  expect(readFileSync(join(data, "cognition", "memory", "rules", "INDEX.md"), "utf8"))
    .toContain("simulating the concrete call path");
});

test("project continuity is visible on the next project turn and isolated from other projects", () => {
  const { root, data, projectA, projectB } = fixture();
  const home = join(root, "home");
  mkdirSync(join(home, "resources", "prompts"), { recursive: true });
  writeFileSync(join(home, "resources", "prompts", "runtime-system-contract.md"), "runtime");
  writeFileSync(join(home, "resources", "prompts", "butler.md"), "butler");
  commitContinuityUpdates({
    butlerData: data,
    decisionId: "decision-next-turn",
    updates: [{
      scope: "project",
      kind: "decision",
      operation: "upsert",
      summary: "Use blue-green rollout for the current service migration.",
    }],
    candidateRefs: [],
    provenance: provenance(),
    boundWorkspacePath: projectA,
  });
  const assembler = new PromptAssembler({ butlerHome: home, butlerData: data });
  const contextA = assembler.buildTurnContext({
    binding: binding(projectA, "project-a", "butler/project-a"),
    envelope: envelope("event-a"),
  });
  const contextB = assembler.buildTurnContext({
    binding: binding(projectB, "project-b", "butler/project-b"),
    envelope: envelope("event-b"),
  });
  expect(contextA).toContain("blue-green rollout");
  expect(contextB).not.toContain("blue-green rollout");
});

test("continuity validation rejects secrets without persisting raw values", () => {
  const { data, projectA } = fixture();
  const secret = "sk_abcdefghijklmnopqrstuvwxyz123456";
  expect(() => commitContinuityUpdates({
    butlerData: data,
    decisionId: "decision-secret",
    updates: [{
      scope: "project",
      kind: "working_state",
      operation: "upsert",
      summary: `Use credential ${secret} for the next operation.`,
    }],
    candidateRefs: [],
    provenance: provenance(),
    boundWorkspacePath: projectA,
  })).toThrow("continuity_secret_rejected");
  expect(existsSync(join(projectA, ".butler", "hot-cache.md"))).toBe(false);
});

function binding(workspacePath: string, projectId: string, sessionId: string): StoredSessionBinding {
  const now = new Date(0).toISOString();
  return {
    sessionId,
    role: "butler",
    projectId,
    workspacePath,
    runtimeAdapterId: "codex-api",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.6-sol",
    transportBindings: [],
    lifecycleState: "active",
    createdAt: now,
    updatedAt: now,
  };
}

function envelope(eventId: string) {
  return {
    eventId,
    transport: "test",
    accountId: "default",
    peer: { kind: "dm" as const, id: "peer" },
    sender: { id: "user" },
    message: { id: eventId, text: "continue", timestamp: new Date(0).toISOString() },
  };
}
