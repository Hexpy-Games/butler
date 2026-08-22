/// <reference types="bun" />

import { expect, test } from "bun:test";
import { snapshotDelegationProjectContext } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/project-context.ts";
import { completePacketContext } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/terminal-results.ts";
import type { DelegationPacket } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/contracts.ts";
import type { TurnRecord } from
  "../../packages/butler-agent/src/agent/btcc/turn/contracts.ts";

const PROJECT_ID = "project-sandy-bot";
const MEMORY_REF = "a".repeat(64);

test("verified project memory admits Steward when no derived hot cache was declared", async () => {
  const snapshot = await snapshotDelegationProjectContext({
    parentSessionId: "sandy-session",
    parentTurnId: "sandy-turn",
    projectId: PROJECT_ID,
    turns: { async findTurn() { return parentTurn({ optionalHotCacheRefs: [MEMORY_REF] }); } },
    documents: {
      resolve: () => "unused",
      read: () => ({
        contextRef: MEMORY_REF,
        contentSha256: "b".repeat(64),
        sourceId: "project-memory",
        projectionClass: "optional_hot_cache",
        scopeKind: "project",
        scopeId: PROJECT_ID,
        sourceRevision: "memory-r1",
        content: "Verified Sandy deployment and API knowledge.",
      }),
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

test("a parent-declared mandatory project cache remains fail closed", async () => {
  const missingRef = "c".repeat(64);
  const snapshot = await snapshotDelegationProjectContext({
    parentSessionId: "sandy-session",
    parentTurnId: "sandy-turn",
    projectId: PROJECT_ID,
    turns: {
      async findTurn() {
        return parentTurn({
          mandatoryHotCacheRefs: [missingRef],
          optionalHotCacheRefs: [MEMORY_REF],
        });
      },
    },
    documents: {
      resolve: () => "unused",
      read: (contextRef) => {
        if (contextRef === missingRef) throw new Error("missing declared hot cache");
        return {
          contextRef: MEMORY_REF,
          contentSha256: "b".repeat(64),
          sourceId: "project-memory",
          projectionClass: "optional_hot_cache" as const,
          scopeKind: "project" as const,
          scopeId: PROJECT_ID,
          sourceRevision: "memory-r1",
          content: "Verified Sandy deployment and API knowledge.",
        };
      },
    },
  });

  expect(snapshot?.required_source_ids).toEqual(["project-hot-cache"]);
  expect(snapshot?.missing_source_ids).toEqual(["project-hot-cache"]);
  expect(completePacketContext(packetWith(snapshot!))).toBe(false);
});

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
