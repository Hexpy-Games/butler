import type { SqliteGuidedToolJournal } from "../../adapters/index.ts";
import type { DurableWorkContext } from "../work/index.ts";
import {
  createM1CompactReplayRecorder,
  type M1CompactReplayStatus,
} from "../../../operations/metrics/m1-compact-replay.ts";
import { M1_COMPACT_REPLAY_FLAG_REVISION } from
  "../../tools/m1-compact-replay.ts";
import {
  createGuidedCompactReplayContext,
  type GuidedCompactReplayContext,
} from "./compact-replay-context.ts";
import {
  resolveGuidedCompactReplayBudget,
  type GuidedCompactReplayBudget,
} from "./guided-compact-replay-budget.ts";

export type GuidedCompactReplayRuntime = {
  context: GuidedCompactReplayContext | null;
  enabled: boolean;
  budget: GuidedCompactReplayBudget;
  observeExactRead(input: {
    success: boolean;
    resultRef?: string | null;
    replayed?: boolean;
  }): void;
  finalize(aborted: boolean): void;
};

export function createDisabledGuidedCompactReplayRuntime(
  modelRef = "openai/gpt-5.6-sol",
): GuidedCompactReplayRuntime {
  return {
    context: null,
    enabled: false,
    budget: resolveGuidedCompactReplayBudget(modelRef),
    observeExactRead() {
      throw new Error("compact_replay_control_disabled");
    },
    finalize() {},
  };
}

export async function createGuidedCompactReplayRuntime(input: {
  enabled: boolean;
  butlerData: string;
  toolJournal: SqliteGuidedToolJournal;
  turnId: string;
  sessionId: string;
  projectRef?: string;
  work: DurableWorkContext | null;
  modelRef: string;
  resolveModelRef?: () => string;
}): Promise<GuidedCompactReplayRuntime> {
  const currentBudget = () => resolveGuidedCompactReplayBudget(
    input.resolveModelRef?.() ?? input.modelRef,
  );
  const budget = currentBudget();
  const recorder = createM1CompactReplayRecorder({
    butlerData: input.butlerData,
    metadata: {
      phaseId: "guided",
      projectionRevision: "0".repeat(64),
      resultRef: null,
      exactRead: null,
      duplicateEffect: null,
      flagRevision: M1_COMPACT_REPLAY_FLAG_REVISION,
    },
  });
  let status: M1CompactReplayStatus = input.enabled ? "error" : "skipped";
  let context: GuidedCompactReplayContext | null = null;
  let exactReadAttempts = 0;
  let exactReadSuccesses = 0;
  let exactReadFailures = 0;
  let replayCount = 0;
  if (input.enabled) {
    try {
      context = await createGuidedCompactReplayContext({
        toolJournal: input.toolJournal,
        turnId: input.turnId,
        sessionId: input.sessionId,
        ...(input.projectRef ? { projectRef: input.projectRef } : {}),
        work: input.work,
        budget,
      });
      recorder.observe({
        projectionRevision: context.projectionRevision,
        resultRef: context.resultRef,
        exactRead: context.exactRead,
        duplicateEffect: context.duplicateEffect,
        projectionCount: context.toolResults.projectionCount +
          (context.workResults?.projectionCount ?? 0),
        anchorCount: context.anchorCount,
        replayCount: context.replayCount,
        exactReadAttempts: context.exactReadAttempts,
        exactReadSuccesses: context.exactReadSuccesses,
        exactReadFailures: context.exactReadFailures,
      });
      exactReadAttempts = context.exactReadAttempts;
      exactReadSuccesses = context.exactReadSuccesses;
      exactReadFailures = context.exactReadFailures;
      status = context.exactRead === false ? "error" : "ok";
    } catch (error) {
      recorder.observe({
        exactRead: false,
        duplicateEffect: null,
        exactReadAttempts: 1,
        exactReadSuccesses: 0,
        exactReadFailures: 1,
        replayCount: 0,
      });
      status = "error";
      recorder.finalize("error");
      throw error;
    }
  }
  return {
    context,
    enabled: input.enabled,
    get budget() {
      return currentBudget();
    },
    observeExactRead(observation) {
      exactReadAttempts += 1;
      if (observation.success) exactReadSuccesses += 1;
      else exactReadFailures += 1;
      if (observation.replayed) replayCount += 1;
      const exactRead = exactReadFailures > 0
        ? false
        : exactReadSuccesses > 0
          ? true
          : null;
      recorder.observe({
        exactRead,
        duplicateEffect: exactRead === true ? false : null,
        resultRef: observation.resultRef ?? null,
        exactReadAttempts,
        exactReadSuccesses,
        exactReadFailures,
        replayCount,
      });
      status = exactReadFailures > 0 ? "error" : "ok";
    },
    finalize(aborted) {
      recorder.finalize(aborted ? "skipped" : status);
    },
  };
}
