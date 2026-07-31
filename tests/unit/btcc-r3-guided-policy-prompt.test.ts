import { expect, test } from "bun:test";
import type { TurnRecord } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import type { SqliteGuidedToolJournal } from
  "../../packages/butler-agent/src/agent/adapters/index.ts";
import {
  guidedPolicy,
} from
  "../../packages/butler-agent/src/agent/composition/production-btcc/guided-turn-policy.ts";
import {
  guidedInstructions,
  renderGuidedPrompt,
} from
  "../../packages/butler-agent/src/agent/composition/production-btcc/guided-turn-prompt.ts";
import { workScopeForTurn } from
  "../../packages/butler-agent/src/agent/composition/production-btcc/guided-work-runtime.ts";
import { appRuntimePolicy } from
  "../../packages/butler-agent/src/gateways/app/domain/runtime/app-runtime-policy.ts";

test("R3 app policy enables session Work by default and preserves explicit opt-out", () => {
  expect(appRuntimePolicy({
    existing: {},
    accessMode: "read_only",
    sessionKind: "chat",
  })).toMatchObject({
    tracking_mode: "local",
    tracking_mode_source: "session_default",
    closeout_strategy: "local_workstream",
  });

  expect(appRuntimePolicy({
    existing: {
      tracking_mode: "none",
      tracking_mode_source: "explicit",
    },
    accessMode: "full_access",
    projectId: "butler",
    sessionKind: "project",
  })).toMatchObject({
    tracking_mode: "none",
    tracking_mode_source: "explicit",
    closeout_strategy: "noop",
  });

  expect(appRuntimePolicy({
    existing: {
      tracking_mode: "none",
      tracking_mode_source: "session_default",
    },
    accessMode: "full_access",
    sessionKind: "chat",
  })).toMatchObject({
    tracking_mode: "local",
    tracking_mode_source: "session_default",
    closeout_strategy: "local_workstream",
  });

  expect(appRuntimePolicy({
    existing: { trackingMode: "none" },
    accessMode: "read_only",
    sessionKind: "chat",
  })).toMatchObject({
    tracking_mode: "local",
    tracking_mode_source: "session_default",
  });

  expect(appRuntimePolicy({
    existing: {},
    accessMode: "full_access",
    projectId: "butler",
    sessionKind: "project",
  })).toMatchObject({
    tracking_mode: "ledger",
    tracking_mode_source: "app_project_default",
    closeout_strategy: "ledger",
  });
});

test("R3 guided fallback uses session or project Work without exposing tracking internals", () => {
  const chatTurn = turnRecord();
  const projectTurn = turnRecord({ projectRef: "butler" });

  expect(guidedPolicy(chatTurn).trackingMode).toBe("local");
  expect(guidedPolicy(projectTurn).trackingMode).toBe("ledger");

  const prompt = renderGuidedPrompt(chatTurn, {
    butlerData: "/tmp/butler-data",
    contextDocuments: { resolve: () => "" },
    toolJournal: emptyToolJournal(),
    workContext: [
      "Objective: Prepare a market brief",
      "Plan: collect sources; compare findings; write report",
      "Next: verify the report",
    ].join("\n"),
  });
  const instructions = guidedInstructions(guidedPolicy(chatTurn));

  expect(prompt).toContain("work storage: session");
  expect(prompt).toContain("## Current Work");
  expect(prompt).toContain("Objective: Prepare a market brief");
  expect(prompt).not.toContain("tracking:");
  expect(instructions).toContain("Use Work when the task needs continuation across turns");
  expect(instructions).toContain("Skip Work for simple conversation");
  expect(instructions).toContain("single-step read-only lookup");
  expect(instructions).toContain("state_effect validation");
  expect(instructions).toContain("Use typed tools for intended source");
  expect(instructions).toContain("Multi-source or multi-step research");
  expect(instructions).toContain("call replace_work_plan before the dependent work");
  expect(instructions).toContain("record_work_checkpoint is optional");
  expect(instructions).toContain(
    "review against the original user request",
  );
  expect(instructions).toContain(
    "despite disclosed non-critical limits",
  );
  expect(instructions).toContain(
    "only for a material unfinished outcome",
  );
  expect(instructions).toContain(
    "do not keep Work open for optional improvements",
  );
  expect(instructions).toContain("If Work bookkeeping fails, continue");
  expect(instructions).not.toContain("tracking=");
  expect(instructions).not.toContain("BTCC states");

  const projectInstructions = guidedInstructions(guidedPolicy(projectTurn));
  expect(projectInstructions).toContain(
    "keep one concise Project Ledger Work record",
  );
  expect(projectInstructions).toContain(
    "Check for related Work first and reuse it when present",
  );
  expect(projectInstructions).toContain(
    "complete the Ledger Work after validating the requested outcome",
  );
  expect(projectInstructions).toContain(
    "An uninitialized Project Ledger has no existing Work to reuse",
  );
  expect(projectInstructions).toContain(
    "Do not create Project Ledger task or attempt hierarchies unless",
  );
  expect(projectInstructions).toContain(
    "If Project Ledger bookkeeping fails, still deliver the truthful result",
  );
  expect(projectInstructions).not.toContain(
    "Do not attempt to mutate the Project Ledger",
  );
});

test("R3 guided prompt reports disabled Work without inventing a Work context", () => {
  const turn = turnRecord({
    executionPolicy: executionPolicy("none"),
  });
  const prompt = renderGuidedPrompt(turn, {
    butlerData: "/tmp/butler-data",
    contextDocuments: { resolve: () => "" },
    toolJournal: emptyToolJournal(),
  });

  expect(prompt).toContain("work storage: disabled");
  expect(prompt).not.toContain("## Current Work");
  expect(guidedInstructions(guidedPolicy(turn))).toContain("Work storage is disabled.");
});

test("R3 Work scope follows explicit storage mode instead of project shell presence", () => {
  const projectTurn = turnRecord({
    projectRef: "butler",
    executionPolicy: executionPolicy("local"),
  });

  expect(workScopeForTurn(projectTurn, "local")).toEqual({
    turnId: projectTurn.turnId,
    sessionId: projectTurn.sessionId,
  });
  expect(workScopeForTurn(projectTurn, "ledger")).toEqual({
    turnId: projectTurn.turnId,
    sessionId: projectTurn.sessionId,
    projectRef: "butler",
  });
});

function turnRecord(options: {
  projectRef?: string;
  executionPolicy?: TurnRecord["context"]["executionPolicy"];
} = {}): TurnRecord {
  return {
    turnId: "turn-r3-policy",
    sessionId: "session-r3-policy",
    inboxId: "inbox-r3-policy",
    triggerKey: "trigger-r3-policy",
    originalMessageId: "message-r3-policy",
    originalMessage: "Please help",
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: { accessMode: "read_only" },
      controlsHash: "controls",
    },
    context: {
      userRef: "local-user",
      ...(options.projectRef ? { projectRef: options.projectRef } : {}),
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: ["workspace:/tmp/workspace"],
      ...(options.executionPolicy
        ? { executionPolicy: options.executionPolicy }
        : {}),
    },
    semanticState: "admitted",
    checkpoint: {
      checkpointId: "checkpoint-r3-policy",
      checkpointRevision: 1,
      kind: "runtime",
      semanticState: "admitted",
    },
    revision: 0,
    executionFence: 0,
  };
}

function executionPolicy(
  trackingMode: "ledger" | "local" | "none",
): NonNullable<TurnRecord["context"]["executionPolicy"]> {
  return {
    role: "butler",
    accessMode: "read_only",
    trackingMode,
    requiredNativeToolProfiles: [],
    requiredNativeTools: [],
    workspacePath: "/tmp/workspace",
  };
}

function emptyToolJournal(): SqliteGuidedToolJournal {
  return { list: () => [] } as unknown as SqliteGuidedToolJournal;
}
