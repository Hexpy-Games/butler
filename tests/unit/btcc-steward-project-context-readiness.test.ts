/// <reference types="bun" />

import { expect, test } from "bun:test";
import { childProjectContextBinding, snapshotDelegationProjectContext } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/project-context.ts";
import { completePacketContext } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/terminal-results.ts";
import type { DelegationPacket } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/contracts.ts";
import type { TurnRecord } from
  "../../packages/butler-agent/src/agent/btcc/turn/contracts.ts";

const PROJECT_ID = "project-sandy-bot";
const MEMORY_REF = "a".repeat(64);
const USER_RULES_REF = "c".repeat(64);
const USER_HOT_CACHE_REF = "d".repeat(64);
const PROJECT_HOT_CACHE_REF = "e".repeat(64);

test("Butler-only mandatory refs do not become Steward project requirements", async () => {
  const snapshot = await snapshotDelegationProjectContext({
    parentSessionId: "sandy-session",
    parentTurnId: "sandy-turn",
    projectId: PROJECT_ID,
    turns: {
      async findTurn() {
        return parentTurn({
          mandatoryHotCacheRefs: [USER_RULES_REF, USER_HOT_CACHE_REF],
          optionalHotCacheRefs: [MEMORY_REF],
        });
      },
    },
    documents: {
      resolve: () => "unused",
      read: projectAndUserDocument,
    },
  });

  expect(snapshot).toMatchObject({
    project_id: PROJECT_ID,
    required_source_ids: [],
    missing_source_ids: [],
    mandatory_refs: [],
    optional_refs: [{ source_id: "project-memory", context_ref: MEMORY_REF }],
  });
  expect(completePacketContext(packetWith(snapshot!))).toBe(true);
});

test("a verified project-scoped hot cache remains exact mandatory child authority", async () => {
  const snapshot = await snapshotDelegationProjectContext({
    parentSessionId: "sandy-session",
    parentTurnId: "sandy-turn",
    projectId: PROJECT_ID,
    turns: {
      async findTurn() {
        return parentTurn({
          mandatoryHotCacheRefs: [USER_RULES_REF, PROJECT_HOT_CACHE_REF],
          optionalHotCacheRefs: [MEMORY_REF],
        });
      },
    },
    documents: {
      resolve: () => "unused",
      read: projectAndUserDocument,
    },
  });

  expect(snapshot?.required_source_ids).toEqual(["project-hot-cache"]);
  expect(snapshot?.missing_source_ids).toEqual([]);
  expect(snapshot?.mandatory_refs).toEqual([
    expect.objectContaining({
      source_id: "project-hot-cache",
      context_ref: PROJECT_HOT_CACHE_REF,
    }),
  ]);
  expect(completePacketContext(packetWith(snapshot!))).toBe(true);
});

test("Steward packet rejects missing or mismatched reviewed Plan provenance", () => {
  const packet = packetWith(undefined);
  expect(completePacketContext({
    ...packet,
    parent_work_ref: { ...packet.parent_work_ref, turn_id: "another-turn" },
  })).toBe(false);
  const missing = { ...packet };
  Reflect.deleteProperty(missing, "parent_work_ref");
  expect(completePacketContext(missing)).toBe(false);
});

test("Steward packet preserves a reviewed Plan with no explicit checks", () => {
  const packet = packetWith(undefined);
  expect(completePacketContext({
    ...packet,
    acceptance_criteria: [],
  })).toBe(true);
});

test("child project binding preserves distinct App and Ledger identities", () => {
  const context = packetWith({
    project_id: "app-project",
    required_source_ids: [],
    missing_source_ids: [],
    mandatory_refs: [],
    optional_refs: [],
  }).project_context;

  expect(childProjectContextBinding(context, {
    projectId: "legacy-app-project",
    appProjectId: "app-project",
    ledgerProjectId: "ledger-project",
  })).toEqual({
    sessionBinding: {
      projectId: "app-project",
      appProjectId: "app-project",
      ledgerProjectId: "ledger-project",
    },
    metadata: {
      project_id: "app-project",
      mandatory_hot_cache_refs: [],
      optional_hot_cache_refs: [],
    },
  });
});

test("child project binding fails closed on packet and parent App identity mismatch", () => {
  const context = packetWith({
    project_id: "packet-project",
    required_source_ids: [],
    missing_source_ids: [],
    mandatory_refs: [],
    optional_refs: [],
  }).project_context;

  expect(() => childProjectContextBinding(context, {
    projectId: "legacy-app-project",
    appProjectId: "verified-app-project",
    ledgerProjectId: "ledger-project",
  })).toThrow("subsession_project_context_mismatch");
  expect(() => childProjectContextBinding(undefined, {
    projectId: "app-project",
  })).toThrow("subsession_project_context_mismatch");
});

test("child project binding never synthesizes a missing Ledger identity", () => {
  const context = packetWith({
    project_id: "app-project",
    required_source_ids: [],
    missing_source_ids: [],
    mandatory_refs: [],
    optional_refs: [],
  }).project_context;

  expect(childProjectContextBinding(context, {
    projectId: "app-project",
  })).toEqual({
    sessionBinding: {
      projectId: "app-project",
      appProjectId: "app-project",
    },
    metadata: {
      project_id: "app-project",
      mandatory_hot_cache_refs: [],
      optional_hot_cache_refs: [],
    },
  });
  expect(childProjectContextBinding(undefined, {})).toBeUndefined();
});

function projectAndUserDocument(contextRef: string) {
  if (contextRef === MEMORY_REF) {
    return {
      contextRef,
      contentSha256: "b".repeat(64),
      sourceId: "project-memory",
      projectionClass: "optional_hot_cache" as const,
      scopeKind: "project" as const,
      scopeId: PROJECT_ID,
      sourceRevision: "memory-r1",
      content: "Verified Sandy deployment and API knowledge.",
    };
  }
  if (contextRef === PROJECT_HOT_CACHE_REF) {
    return {
      contextRef,
      contentSha256: "f".repeat(64),
      sourceId: "project-hot-cache",
      projectionClass: "mandatory_hot_cache" as const,
      scopeKind: "project" as const,
      scopeId: PROJECT_ID,
      sourceRevision: "hot-r1",
      content: "Verified current Sandy project context.",
    };
  }
  return {
    contextRef,
    contentSha256: "9".repeat(64),
    sourceId: contextRef === USER_RULES_REF ? "rules" : "hot-cache",
    projectionClass: "mandatory_hot_cache" as const,
    scopeKind: "user" as const,
    scopeId: "user",
    sourceRevision: "user-r1",
    content: "Private Butler-only context.",
  };
}

function parentTurn(context: Partial<TurnRecord["context"]>): TurnRecord {
  return {
    turnId: "sandy-turn",
    sessionId: "sandy-session",
    inboxId: "sandy-inbox",
    triggerKey: "sandy-trigger",
    originalMessageId: "sandy-message",
    originalMessage: "Inspect the Sandy API call shape.",
    modelSelection: {
      provider: "openai",
      model: "gpt-5.5",
      reasoningEffort: "low",
      controls: {},
      controlsHash: "controls",
    },
    context: {
      userRef: "user",
      projectRef: PROJECT_ID,
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [],
      executionPolicy: {
        role: "butler",
        accessMode: "full_access",
        trackingMode: "ledger",
        requiredNativeToolProfiles: ["project-files"],
        requiredNativeTools: ["read_file"],
        workspacePath: "/tmp/sandy",
        projectId: PROJECT_ID,
      },
      ...context,
    },
    semanticState: "admitted",
    revision: 1,
    executionFence: 1,
  };
}

function packetWith(projectContext: DelegationPacket["project_context"]): DelegationPacket {
  return {
    delegation_id: "delegation-sandy",
    task_id: "task-sandy",
    parent_session_id: "sandy-session",
    parent_turn_id: "sandy-turn",
    relation_id: "relation-sandy",
    execution_mode: "read_only",
    objective: "Inspect the Sandy API request shape.",
    acceptance_criteria: ["Return the verified request shape."],
    task_or_plan_refs: [],
    project_context: projectContext,
    constraints_and_non_goals: [],
    allowed_tools_and_effects: [
      "grep_files:workspace",
      "list_files:workspace",
      "read_file:workspace",
      "web_read:network",
      "web_search:network",
    ],
    mutation_scope: [],
    workspace_and_worktree: {
      ownership: "project",
      workspace_label: "Validated project workspace",
      repository_anchor_ref: "parent-session-project",
    },
    expected_result_schema: {
      version: 1,
      status: "success",
      required_fields: ["summary", "acceptance_evidence", "changed_artifacts"],
    },
    work_creation_policy: "one_recoverable_child_work",
    parent_work_ref: {
      work_id: "guided-work-reviewed",
      session_id: "sandy-session",
      turn_id: "sandy-turn",
      plan_revision_id: "plan-reviewed",
      review_revision_id: "review-reviewed",
    },
    access_and_budget_policy: {
      access_mode: "read_only",
      max_turns: 8,
      model_ref: "openai/gpt-5.5",
      reasoning_effort: "low",
    },
    model_ref: "openai/gpt-5.5",
    reasoning_effort: "low",
  };
}
