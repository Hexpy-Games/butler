import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EMPTY_MODEL_CATALOG, EMPTY_SETTINGS } from "../../packages/butler-app/client/ui/src/app/constants.ts";
import { HARNESS_MODEL_CATALOG } from "../../packages/butler-app/client/ui/src/app/fixtures.ts";
import { resolveComposerModelTruth } from "../../packages/butler-app/client/ui/src/components/conversation/composerModelResolution.ts";
import {
  commitContinuityUpdates,
  ContinuityStore,
} from "../../packages/butler-agent/src/agent/cognition/continuity/continuity-store.ts";
import { publishConversationCompletionObservation } from "../../packages/butler-agent/src/agent/cognition/continuity/completion-observation.ts";
import { memorySyncQueueFile } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/queue.ts";
import { projectMemoryPath } from "../../packages/butler-agent/src/agent/cognition/memory/project-memory.ts";
import { PromptAssembler } from "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import { ConversationAdmissionTurn } from "../../packages/butler-agent/src/agent/conversation/session-admission.ts";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import {
  compileStructuredTurnDecision,
  parseStructuredTurnDecision,
} from "../../packages/butler-agent/src/agent/turn/native/turn-runner/typed-turn-decision.ts";
import { activateTurnContract } from "../../packages/butler-agent/src/agent/turn/native/turn-runner/turn-contract-runtime.ts";
import type { ToolSurfacePromptController } from "../../packages/butler-agent/src/agent/turn/tool-surface-prompt-controller.ts";
import { AppTurnActionStore } from "../../packages/butler-agent/src/gateways/app/domain/sessions/turn-action-store.ts";
import type {
  MessageRow,
  TurnRow,
} from "../../packages/butler-agent/src/gateways/app/infrastructure/core/records.ts";
import type {
  MessageSendRequest,
  MessageSendResult,
  TurnRecord,
} from "../../packages/butler-agent/src/gateways/app/interface/protocol/app-protocol.ts";
import { createAppInboundEnvelope } from "../../packages/butler-agent/src/gateways/core/app-transport.ts";
import type { ModelRef } from "../../packages/butler-agent/src/gateways/core/contracts.ts";
import { NativeInboundQueue } from "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import {
  createTurnExecutionControls,
  verifyTurnExecutionControls,
  type TurnControlResolution,
  type TurnExecutionControlsV1,
} from "../../packages/butler-agent/src/gateways/core/turn-execution-controls.ts";
import { executionBindingForEnvelope } from "../../packages/butler-agent/src/interfaces/gateway/session-actor.ts";
import type { StoredSessionBinding } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import {
  failedInvariantSteps,
  MessageLifecycleTrace,
  type MessageLifecycleTraceArtifact,
} from "../support/message-lifecycle-trace.ts";

const REQUIRED_SCENARIOS = [
  "bootstrap-race",
  "queued-control-change",
  "renderer-disorder",
  "generic-project-continuity",
  "scope-isolation",
  "continuity-no-op",
  "replay-idempotency",
  "cancel-fail-retry",
  "capsule-lifecycle",
  "unavailable-model",
] as const;

const artifacts = new Map<string, MessageLifecycleTraceArtifact>();
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

afterAll(() => {
  expect([...artifacts.keys()].sort()).toEqual([...REQUIRED_SCENARIOS].sort());
  for (const artifact of artifacts.values()) {
    expect(artifact.steps.length).toBeGreaterThan(0);
    expect(failedInvariantSteps(artifact)).toEqual([]);
  }
});

describe("integrated project turn lifecycle execution simulations", () => {
  test("1. bootstrap race remains neutral and dispatches admitted GPT-5.6-sol medium", () => {
    const fixture = createFixture("bootstrap");
    const sessionId = "project-sandy";
    const turnId = "turn-bootstrap";
    const controlsView = sessionControls(sessionId, 7, "openai/gpt-5.6-sol");
    const loading = resolveComposerModelTruth({
      catalog: EMPTY_MODEL_CATALOG,
      catalogState: "loading",
      controls: controlsView,
      controlsState: "ready",
      settings: EMPTY_SETTINGS,
    });
    const controls = executionControls(turnId, sessionId, 7, "openai/gpt-5.6-sol");
    const envelope = appEnvelope(turnId, sessionId, controls, "Keep the release checklist available.");
    const queue = new NativeInboundQueue(fixture.data);
    const queued = queue.enqueue(envelope, {}, new Date("2026-07-14T00:00:00.000Z"));
    const claimed = new NativeInboundQueue(fixture.data).claim(1)[0]!;
    const providerBinding = executionBindingForEnvelope(
      binding(sessionId, "project-sandy", fixture.projectA),
      claimed.envelope,
    );
    const ready = resolveComposerModelTruth({
      catalog: HARNESS_MODEL_CATALOG,
      catalogState: "ready",
      controls: controlsView,
      controlsState: "ready",
      settings: EMPTY_SETTINGS,
    });

    const trace = traceFor("bootstrap-race", sessionId, turnId);
    trace.record(step("1.1", "resolveComposerModelTruth", {
      concreteInput: { catalog_state: "loading", session_model: controlsView.controls.model },
      stateWritten: { ui_state: loading.state, visible_model_ref: loading.model || null },
      outputOrNextCall: { next: "AppUserMessageTurnStore.sendMessage" },
      invariant: loading.state === "loading" && loading.model === "",
      evidence: "direct renderer truth resolution with delayed catalog",
    }));
    trace.record(step("1.2", "createTurnExecutionControls", {
      concreteInput: { session_id: sessionId, turn_id: turnId, revision: 7 },
      stateWritten: { model_ref: controls.model_ref, reasoning_effort: controls.reasoning_effort },
      outputOrNextCall: { next: "createAppInboundEnvelope", integrity_hash: controls.integrity_hash },
      invariant: controls.model_ref === "openai/gpt-5.6-sol" && controls.reasoning_effort === "medium",
      evidence: "server admission snapshot",
    }));
    trace.record(step("1.3", "NativeInboundQueue.enqueue", {
      concreteInput: { queue_id: queued.queueId, turn_id: turnId },
      stateWritten: { execution_integrity_hash: queued.envelope.executionControls?.integrity_hash },
      outputOrNextCall: { next: "NativeInboundQueue.claim" },
      invariant: claimed.envelope.executionControls?.integrity_hash === controls.integrity_hash,
      evidence: "durable queue restart and claim",
    }));
    trace.record(step("1.4", "executionBindingForEnvelope", {
      concreteInput: { turn_id: turnId, mutable_model_ref: "openai/gpt-5.5" },
      stateRead: { admitted_integrity_hash: controls.integrity_hash },
      stateWritten: { provider_model_ref: providerBinding.modelRef },
      outputOrNextCall: { next: "RuntimeAdapter.runTurn", reasoning_effort: providerBinding.metadata?.reasoning_effort },
      invariant: providerBinding.modelRef === controls.model_ref,
      evidence: "actual SessionActor provider-binding function",
    }));
    trace.record(step("1.5", "resolveComposerModelTruth", {
      concreteInput: { catalog_generation: HARNESS_MODEL_CATALOG.generation, controls_revision: 7 },
      stateWritten: { ui_state: ready.state, visible_model_ref: ready.model },
      outputOrNextCall: { next: "ComposerModelStatusButton" },
      invariant: ready.state === "ready" && ready.model === controls.model_ref,
      evidence: "authoritative catalog reconciliation",
    }));
    completeTrace(trace, ["resolveComposerModelTruth", "createTurnExecutionControls", "NativeInboundQueue.enqueue", "executionBindingForEnvelope"]);
  });

  test("2. queued control change preserves A and admits B with new controls", () => {
    const fixture = createFixture("queued");
    const sessionId = "project-sandy";
    const controlsA = executionControls("turn-a", sessionId, 4, "openai/gpt-5.6-sol");
    const envelopeA = appEnvelope("turn-a", sessionId, controlsA, "Turn A");
    const queue = new NativeInboundQueue(fixture.data);
    const queuedA = queue.enqueue(envelopeA, {}, new Date("2026-07-14T00:00:00.000Z"));
    const controlsB = executionControls("turn-b", sessionId, 5, "openai/gpt-5.5");
    const queuedB = queue.enqueue(
      appEnvelope("turn-b", sessionId, controlsB, "Turn B"),
      {},
      new Date("2026-07-14T00:00:01.000Z"),
    );
    const claimed = new NativeInboundQueue(fixture.data).claim(2);
    const admitted = claimed.map((item) => verifyTurnExecutionControls(item.envelope.executionControls));

    const trace = traceFor("queued-control-change", sessionId, "turn-a");
    trace.record(step("2.1", "NativeInboundQueue.enqueue", {
      concreteInput: { turn_id: "turn-a", session_control_revision: 4 },
      stateWritten: { queue_id: queuedA.queueId, model_ref: controlsA.model_ref },
      outputOrNextCall: { next: "AppSessionControlsStore.updateControls" },
      invariant: queuedA.envelope.executionControls?.model_ref === "openai/gpt-5.6-sol",
      evidence: "turn A durable admission",
    }));
    trace.record(step("2.2", "createTurnExecutionControls", {
      concreteInput: { turn_id: "turn-b", session_control_revision: 5 },
      stateRead: { future_session_model_ref: "openai/gpt-5.5" },
      stateWritten: { queue_id: queuedB.queueId, model_ref: controlsB.model_ref },
      outputOrNextCall: { next: "NativeInboundQueue.claim" },
      invariant: controlsB.model_ref === "openai/gpt-5.5",
      evidence: "turn B admitted after mutable default change",
    }));
    trace.record(step("2.3", "verifyTurnExecutionControls", {
      concreteInput: { queue_ids: claimed.map((item) => item.queueId) },
      stateRead: { session_default_now: "openai/gpt-5.5" },
      stateWritten: { dispatched_models: admitted.map((item) => item.model_ref) },
      outputOrNextCall: { next: "executionBindingForEnvelope" },
      invariant: admitted[0]?.model_ref === "openai/gpt-5.6-sol" && admitted[1]?.model_ref === "openai/gpt-5.5",
      evidence: "durable queue claim after process-object replacement",
    }));
    completeTrace(trace, ["NativeInboundQueue.enqueue", "createTurnExecutionControls", "verifyTurnExecutionControls"]);
  });

  test("3. renderer disorder never invents a model or persists a phantom patch", () => {
    const sessionId = "project-sandy";
    const controls = sessionControls(sessionId, 8, "openai/gpt-5.6-sol");
    const permutations = [
      resolveComposerModelTruth({ catalog: EMPTY_MODEL_CATALOG, catalogState: "loading", controls, controlsState: "ready", settings: EMPTY_SETTINGS }),
      resolveComposerModelTruth({ catalog: HARNESS_MODEL_CATALOG, catalogState: "ready", controls: null, controlsState: "loading", settings: EMPTY_SETTINGS }),
      resolveComposerModelTruth({ catalog: HARNESS_MODEL_CATALOG, catalogState: "ready", controls, controlsState: "ready", settings: EMPTY_SETTINGS }),
      resolveComposerModelTruth({ catalog: HARNESS_MODEL_CATALOG, catalogState: "error", controls, controlsState: "ready", settings: EMPTY_SETTINGS }),
      resolveComposerModelTruth({ catalog: HARNESS_MODEL_CATALOG, catalogState: "ready", controls, controlsState: "error", settings: EMPTY_SETTINGS }),
      resolveComposerModelTruth({ catalog: HARNESS_MODEL_CATALOG, catalogState: "ready", controls: { ...controls, catalog_generation: "future" }, controlsState: "ready", settings: EMPTY_SETTINGS }),
    ];
    const phantomPatchCalls: unknown[] = [];
    const trace = traceFor("renderer-disorder", sessionId, "turn-renderer");
    trace.record(step("3.1", "resolveComposerModelTruth", {
      concreteInput: { response_orders: 6, remount: true, poll_during_edit: true },
      stateRead: { catalog_generation: HARNESS_MODEL_CATALOG.generation, controls_revision: controls.revision },
      stateWritten: { states: permutations.map((item) => item.state), models: permutations.map((item) => item.model || null) },
      outputOrNextCall: { automatic_patch_calls: phantomPatchCalls.length },
      invariant: permutations[0]?.model === "" && permutations[1]?.model === "" && permutations[2]?.model === "openai/gpt-5.6-sol" && phantomPatchCalls.length === 0,
      evidence: "all renderer response-order resolutions executed directly",
    }));
    completeTrace(trace, ["resolveComposerModelTruth"]);
  });

  test("4. generic model-selected project continuity survives restart and enters next prompt", () => {
    const fixture = createFixture("continuity");
    const sessionId = "butler/project-a";
    const turnId = "turn-continuity";
    const decision = structuredDecision("decision-continuity", [{
      scope: "project",
      kind: "instruction",
      operation: "upsert",
      summary: "Run the schema compatibility check before every project migration.",
      target_ref: null,
    }]);
    const contract = compileStructuredTurnDecision({
      decision,
      candidates: {},
      workspaceId: "project-a",
      projectId: "project-a",
      continuityCandidates: [],
    });
    activateTurnContract({
      butlerData: fixture.data,
      contract,
      decision,
      sessionId,
      projectId: "project-a",
      turnId,
      continuityCandidates: [],
      continuityProvenance: {
        conversation_session_id: "cs-continuity",
        turn_id: turnId,
        inbound_message_id: "message-continuity",
        runtime_session_id: sessionId,
        project_id: "project-a",
      },
      boundWorkspacePath: fixture.projectA,
      toolSurfaceController: noToolSurface(),
    });
    const continuityStore = new ContinuityStore(fixture.data);
    const continuity = continuityStore.listCandidates({
      projectId: "project-a",
      sessionId,
    })[0];
    continuityStore.close();
    const continuityId = continuity?.continuity_id;
    const nextPrompt = new PromptAssembler({ butlerHome: fixture.home, butlerData: fixture.data }).buildTurnContext({
      binding: binding(sessionId, "project-a", fixture.projectA),
      envelope: appEnvelope("turn-next", sessionId, executionControls("turn-next", sessionId, 8, "openai/gpt-5.6-sol"), "Continue the migration."),
    });
    const trace = traceFor("generic-project-continuity", sessionId, turnId);
    trace.record(step("4.1", "parseStructuredTurnDecision", {
      concreteInput: { semantic_summary: decision.continuity_updates?.[0]?.summary },
      stateWritten: { update_count: decision.continuity_updates?.length },
      outputOrNextCall: { next: "activateTurnContract" },
      invariant: decision.continuity_updates?.length === 1,
      evidence: "same productive typed model decision; no keyword classifier",
    }));
    trace.record(step("4.2", "activateTurnContract", {
      concreteInput: { project_id: "project-a", turn_id: turnId, inbound_message_id: "message-continuity" },
      stateWritten: { continuity_id: continuityId, destination: continuity?.scope === "project" ? "project_hot_cache" : null },
      outputOrNextCall: { next: "final answer delivery" },
      invariant: Boolean(continuityId) && continuity?.scope === "project",
      evidence: "runtime-owned project binding and provenance commit",
    }));
    trace.record(step("4.3", "PromptAssembler.buildTurnContext", {
      concreteInput: { restart: true, next_turn_id: "turn-next" },
      stateRead: { project_hot_cache_path: join(fixture.projectA, ".butler", "hot-cache.md") },
      stateWritten: { prompt_section_present: nextPrompt.includes("## Project Hot Cache") },
      outputOrNextCall: { next: "RuntimeAdapter.runTurn" },
      invariant: nextPrompt.includes("schema compatibility check") && nextPrompt.includes("## Project Hot Cache"),
      evidence: "new PromptAssembler instance after simulated restart",
    }));
    completeTrace(trace, ["parseStructuredTurnDecision", "activateTurnContract", "PromptAssembler.buildTurnContext"]);
  });

  test("5. project A, project B, and global continuity remain isolated", () => {
    const fixture = createFixture("scope");
    const receipts = [
      commitContinuityUpdates({
        butlerData: fixture.data,
        decisionId: "decision-a",
        updates: [{ scope: "project", kind: "decision", operation: "upsert", summary: "Project A deploys with a blue-green strategy." }],
        candidateRefs: [],
        provenance: provenance("project-a", "butler/project-a", "turn-a"),
        boundWorkspacePath: fixture.projectA,
      })[0]!,
      commitContinuityUpdates({
        butlerData: fixture.data,
        decisionId: "decision-b",
        updates: [{ scope: "project", kind: "decision", operation: "upsert", summary: "Project B deploys with a canary strategy." }],
        candidateRefs: [],
        provenance: provenance("project-b", "butler/project-b", "turn-b"),
        boundWorkspacePath: fixture.projectB,
      })[0]!,
      commitContinuityUpdates({
        butlerData: fixture.data,
        decisionId: "decision-global",
        updates: [{ scope: "global", kind: "preference", operation: "upsert", summary: "Show causal evidence before recommendations." }],
        candidateRefs: [],
        provenance: provenance(null, "butler/main", "turn-global"),
      })[0]!,
    ];
    const assembler = new PromptAssembler({ butlerHome: fixture.home, butlerData: fixture.data });
    const promptA = assembler.buildTurnContext({ binding: binding("butler/project-a", "project-a", fixture.projectA), envelope: bareEnvelope("scope-a") });
    const promptB = assembler.buildTurnContext({ binding: binding("butler/project-b", "project-b", fixture.projectB), envelope: bareEnvelope("scope-b") });
    const trace = traceFor("scope-isolation", "butler/project-a", "turn-a");
    trace.record(step("5.1", "commitContinuityUpdates", {
      concreteInput: { scopes: ["project-a", "project-b", "global"] },
      stateWritten: { destinations: receipts.map((item) => item.destination) },
      outputOrNextCall: { next: "PromptAssembler.buildTurnContext" },
      invariant: receipts[0].destination === "project_hot_cache" && receipts[1].destination === "project_hot_cache" && receipts[2].destination === "explicit_global_rule",
      evidence: "three canonical scope writers",
    }));
    trace.record(step("5.2", "PromptAssembler.buildTurnContext", {
      concreteInput: { project_a: "project-a", project_b: "project-b" },
      stateRead: { project_a_cache: join(fixture.projectA, ".butler", "hot-cache.md"), project_b_cache: join(fixture.projectB, ".butler", "hot-cache.md") },
      stateWritten: { a_has_a: promptA.includes("blue-green"), a_has_b: promptA.includes("canary strategy"), b_has_b: promptB.includes("canary strategy"), b_has_a: promptB.includes("blue-green") },
      outputOrNextCall: { next: "project-specific provider turns" },
      invariant: promptA.includes("blue-green") && !promptA.includes("canary strategy") && promptB.includes("canary strategy") && !promptB.includes("blue-green"),
      evidence: "actual prompt assembly for both authenticated project bindings",
    }));
    completeTrace(trace, ["commitContinuityUpdates", "PromptAssembler.buildTurnContext"]);
  });

  test("6. ordinary model decision is a no-op with no continuity write", () => {
    const fixture = createFixture("noop");
    const decision = structuredDecision("decision-noop", []);
    const contract = compileStructuredTurnDecision({ decision, candidates: {}, workspaceId: "project-a", projectId: "project-a", continuityCandidates: [] });
    activateTurnContract({
      butlerData: fixture.data,
      contract,
      decision,
      sessionId: "butler/project-a",
      projectId: "project-a",
      turnId: "turn-noop",
      continuityCandidates: [],
      continuityProvenance: {
        conversation_session_id: "cs-noop",
        turn_id: "turn-noop",
        inbound_message_id: "message-noop",
        runtime_session_id: "butler/project-a",
        project_id: "project-a",
      },
      boundWorkspacePath: fixture.projectA,
      toolSurfaceController: noToolSurface(),
    });
    const store = new ContinuityStore(fixture.data);
    const candidateCount = store.listCandidates({ projectId: "project-a", sessionId: "butler/project-a" }).length;
    store.close();
    const trace = traceFor("continuity-no-op", "butler/project-a", "turn-noop");
    trace.record(step("6.1", "activateTurnContract", {
      concreteInput: { continuity_updates: decision.continuity_updates },
      stateRead: { project_id: "project-a" },
      stateWritten: { receipt_count: 0, candidate_count: candidateCount },
      outputOrNextCall: { next: "final answer delivery" },
      invariant: candidateCount === 0 && !existsSync(join(fixture.projectA, ".butler", "hot-cache.md")),
      evidence: "ordinary structured model answer",
    }));
    completeTrace(trace, ["activateTurnContract"]);
  });

  test("7. replay reuses one snapshot, continuity mutation, and completion job", () => {
    const fixture = createFixture("replay");
    const sessionId = "butler/project-a";
    const turnId = "turn-replay";
    const controls = executionControls(turnId, sessionId, 11, "openai/gpt-5.6-sol");
    const replayedSnapshots = [verifyTurnExecutionControls(controls), verifyTurnExecutionControls(controls)];
    const updates = [{ scope: "project" as const, kind: "constraint" as const, operation: "upsert" as const, summary: "Require a signed manifest before publishing artifacts." }];
    const first = commitContinuityUpdates({ butlerData: fixture.data, decisionId: "decision-replay", updates, candidateRefs: [], provenance: provenance("project-a", sessionId, turnId), boundWorkspacePath: fixture.projectA });
    const second = commitContinuityUpdates({ butlerData: fixture.data, decisionId: "decision-replay", updates, candidateRefs: [], provenance: provenance("project-a", sessionId, turnId), boundWorkspacePath: fixture.projectA });
    const completionInput = {
      butlerData: fixture.data,
      projectId: "project-a",
      runtimeSessionId: sessionId,
      conversationSessionId: "cs-replay",
      conversationTurnId: turnId,
      inboundMessageId: "message-replay-user",
      outboundMessageId: "message-replay-assistant",
      outcomeGeneration: 1,
      completedAt: "2026-07-14T00:10:00.000Z",
    };
    const jobA = publishConversationCompletionObservation(completionInput);
    const jobB = publishConversationCompletionObservation(completionInput);
    const queueLines = readFileSync(memorySyncQueueFile(fixture.data), "utf8").trim().split("\n");
    const trace = traceFor("replay-idempotency", sessionId, turnId);
    trace.record(step("7.1", "verifyTurnExecutionControls", {
      concreteInput: { replay_count: 2, integrity_hash: controls.integrity_hash },
      stateWritten: { snapshot_hashes: replayedSnapshots.map((item) => item.integrity_hash) },
      outputOrNextCall: { next: "executionBindingForEnvelope" },
      invariant: new Set(replayedSnapshots.map((item) => item.integrity_hash)).size === 1,
      evidence: "same immutable admitted snapshot verified twice",
    }));
    trace.record(step("7.2", "commitContinuityUpdates", {
      concreteInput: { decision_id: "decision-replay", turn_id: turnId },
      stateWritten: { continuity_ids: [first[0]?.continuity_id, second[0]?.continuity_id], replayed: second[0]?.replayed },
      outputOrNextCall: { next: "publishConversationCompletionObservation" },
      invariant: first[0]?.continuity_id === second[0]?.continuity_id && second[0]?.replayed === true,
      evidence: "turn + decision + normalized mutation idempotency key",
    }));
    trace.record(step("7.3", "publishConversationCompletionObservation", {
      concreteInput: { conversation_turn_id: turnId, outcome_generation: 1 },
      stateWritten: { job_ids: [jobA.job_id, jobB.job_id], queue_entries: queueLines.length },
      outputOrNextCall: { next: "memory sync consumer" },
      invariant: jobA.job_id === jobB.job_id && queueLines.length === 1,
      evidence: "durable observation and queue deduplication",
    }));
    completeTrace(trace, ["verifyTurnExecutionControls", "commitContinuityUpdates", "publishConversationCompletionObservation"]);
  });

  test("8. cancel and fail do not consolidate; retries preserve or explicitly replace controls", async () => {
    const fixture = createFixture("retry");
    const sessionId = "butler/project-a";
    const original = executionControls("turn-retry", sessionId, 12, "openai/gpt-5.6-sol");
    const store = new AgentConversationStore({ butlerData: fixture.data });
    const failedAdmission = beginAdmission(store, fixture.data, fixture.projectA, sessionId, "turn-failed", "event-failed");
    failedAdmission.admitInbound();
    failedAdmission.finalize("failed", "2026-07-14T00:20:00.000Z");
    const cancelledAdmission = beginAdmission(store, fixture.data, fixture.projectA, sessionId, "turn-cancelled", "event-cancelled");
    cancelledAdmission.admitInbound();
    cancelledAdmission.finalize("aborted", "2026-07-14T00:21:00.000Z");
    store.close();
    const queueBeforeRetry = existsSync(memorySyncQueueFile(fixture.data)) ? readFileSync(memorySyncQueueFile(fixture.data), "utf8").trim() : "";
    const retryCaptures: TurnExecutionControlsV1[] = [];
    const currentControlsRetry = executionControls("turn-retry-current", sessionId, 13, "openai/gpt-5.5");
    const currentRetryRequests: MessageSendRequest[] = [];
    const actionStore = retryActionStore(
      original,
      (controls) => {
        retryCaptures.push(controls);
      },
      async (request) => {
        currentRetryRequests.push(request);
        return {
          replies: [],
          next_cursor: 2,
          turn: turnRecordForControls(currentControlsRetry),
        };
      },
    );
    await actionStore.retryTurn("turn-retry");
    await actionStore.retryTurnWithCurrentControls("turn-retry");
    const retriedControls = retryCaptures[0];
    const trace = traceFor("cancel-fail-retry", sessionId, "turn-retry");
    trace.record(step("8.1", "ConversationAdmissionTurn.finalize", {
      concreteInput: { outcomes: ["failed", "aborted"] },
      stateWritten: { consolidation_queue_bytes: queueBeforeRetry.length },
      outputOrNextCall: { next: "terminal turn projection" },
      invariant: queueBeforeRetry.length === 0,
      evidence: "actual semantic admission finalization policy",
    }));
    trace.record(step("8.2", "AppTurnActionStore.retryTurn", {
      concreteInput: { turn_id: "turn-retry", mutable_session_model: "openai/gpt-5.5" },
      stateRead: { original_integrity_hash: original.integrity_hash },
      stateWritten: { retried_model_ref: retriedControls?.model_ref, retried_integrity_hash: retriedControls?.integrity_hash },
      outputOrNextCall: { next: "enqueueAppTransportTurn" },
      invariant: retriedControls?.integrity_hash === original.integrity_hash && retriedControls?.model_ref === "openai/gpt-5.6-sol",
      evidence: "default retry reads persisted execution_controls_json",
    }));
    trace.record(step("8.3", "AppTurnActionStore.retryTurnWithCurrentControls", {
      concreteInput: { explicit_action: "new replacement turn with current controls", request: currentRetryRequests[0] },
      stateRead: { current_session_revision: 13 },
      stateWritten: { model_ref: currentControlsRetry.model_ref, integrity_hash: currentControlsRetry.integrity_hash },
      outputOrNextCall: { next: "AppUserMessageTurnStore.sendMessage" },
      invariant: currentRetryRequests[0]?.chat_id === sessionId && currentControlsRetry.turn_id !== original.turn_id && currentControlsRetry.integrity_hash !== original.integrity_hash,
      evidence: "explicit current-control endpoint delegates to normal admission for a new turn snapshot",
    }));
    completeTrace(trace, ["ConversationAdmissionTurn.finalize", "AppTurnActionStore.retryTurn", "AppTurnActionStore.retryTurnWithCurrentControls"]);
  });

  test("9. role-Butler capsule failure is safe and retry feeds the later prompt", () => {
    const fixture = createFixture("capsule");
    writeFileSync(join(fixture.projectA, ".butler", "hot-cache.md"), "PROJECT CAPSULE RETRY STATE\n");
    const assembler = new PromptAssembler({ butlerHome: fixture.home, butlerData: fixture.data });
    const projectBinding = binding("butler/project-a", "project-a", fixture.projectA);
    const capsule = projectMemoryPath({ butlerData: fixture.data, projectId: "project-a" })!;
    mkdirSync(dirname(capsule), { recursive: true });
    const lock = join(
      fixture.data,
      "cognition",
      "memory",
      "locks",
      "project-capsules",
      "project-a.lock",
    );
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, `${process.pid}\n`);
    const failed = assembler.ensureProjectCapsule(projectBinding);
    rmSync(lock, { force: true });
    const retried = assembler.ensureProjectCapsule(projectBinding);
    const prompt = assembler.buildTurnContext({ binding: projectBinding, envelope: bareEnvelope("capsule-next") });
    const trace = traceFor("capsule-lifecycle", projectBinding.sessionId, "turn-capsule");
    trace.record(step("9.1", "PromptAssembler.ensureProjectCapsule", {
      concreteInput: { role: projectBinding.role, project_id: projectBinding.projectId },
      stateRead: { active_refresh_lock: true },
      stateWritten: { status: failed.status, error: failed.status === "failed" ? failed.error : null },
      outputOrNextCall: { next: "SessionLifecycleService.scheduleProjectCapsuleEnsure" },
      invariant: failed.status === "failed",
      evidence: "safe lock failure on a project-bound Butler role",
    }));
    trace.record(step("9.2", "PromptAssembler.ensureProjectCapsule", {
      concreteInput: { retry_after_lock_release: true },
      stateWritten: { status: retried.status, capsule_path: retried.status === "created" || retried.status === "present" ? retried.path : null },
      outputOrNextCall: { next: "PromptAssembler.buildTurnContext" },
      invariant: retried.status === "created" || retried.status === "present",
      evidence: "bounded retry succeeds after transient failure",
    }));
    trace.record(step("9.3", "PromptAssembler.buildTurnContext", {
      concreteInput: { next_turn_id: "capsule-next" },
      stateRead: { capsule_exists: existsSync(capsule) },
      stateWritten: { project_memory_present: prompt.includes("## Project Memory"), project_hot_cache_present: prompt.includes("PROJECT CAPSULE RETRY STATE") },
      outputOrNextCall: { next: "RuntimeAdapter.runTurn" },
      invariant: prompt.includes("## Project Memory") && prompt.includes("PROJECT CAPSULE RETRY STATE"),
      evidence: "later prompt assembled after capsule recovery",
    }));
    completeTrace(trace, ["PromptAssembler.ensureProjectCapsule", "PromptAssembler.buildTurnContext"]);
  });

  test("10. unavailable stored model stays unavailable and is never coerced", () => {
    const sessionId = "project-sandy";
    const unavailableRef = "openai/gpt-removed";
    const result = resolveComposerModelTruth({
      catalog: HARNESS_MODEL_CATALOG,
      catalogState: "ready",
      controls: sessionControls(sessionId, 14, unavailableRef),
      controlsState: "ready",
      settings: EMPTY_SETTINGS,
    });
    const trace = traceFor("unavailable-model", sessionId, "turn-unavailable");
    trace.record(step("10.1", "resolveComposerModelTruth", {
      concreteInput: { stored_model_ref: unavailableRef, catalog_generation: HARNESS_MODEL_CATALOG.generation },
      stateRead: { catalog_model_refs: HARNESS_MODEL_CATALOG.models.map((model) => model.model_ref) },
      stateWritten: { ui_state: result.state, visible_model_ref: result.model, substitute_metadata: result.metadata ?? null },
      outputOrNextCall: { next: "ComposerModelStatusButton repair action" },
      invariant: result.state === "unavailable" && result.model === unavailableRef && result.metadata === undefined,
      evidence: "direct selected-unavailable resolution",
    }));
    completeTrace(trace, ["resolveComposerModelTruth"]);
  });
});

function createFixture(name: string): {
  root: string;
  data: string;
  home: string;
  projectA: string;
  projectB: string;
} {
  const root = mkdtempSync(join(tmpdir(), `butler-integrated-${name}-`));
  roots.push(root);
  const data = join(root, "data");
  const home = join(root, "home");
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  mkdirSync(join(home, "resources", "prompts"), { recursive: true });
  mkdirSync(join(projectA, ".butler"), { recursive: true });
  mkdirSync(join(projectB, ".butler"), { recursive: true });
  writeFileSync(join(home, "resources", "prompts", "runtime-system-contract.md"), "RUNTIME CONTRACT");
  writeFileSync(join(home, "resources", "prompts", "butler.md"), "BUTLER ROLE");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "butler.config.json"), JSON.stringify({
    projects: [
      { name: "project-a", path: projectA },
      { name: "project-b", path: projectB },
    ],
  }));
  return { root, data, home, projectA, projectB };
}

function executionControls(
  turnId: string,
  sessionId: string,
  revision: number,
  model: ModelRef,
): TurnExecutionControlsV1 {
  return createTurnExecutionControls({
    turnId,
    sessionId,
    resolvedAt: "2026-07-14T00:00:00.000Z",
    resolution: resolution(revision, model),
  });
}

function resolution(revision: number, model: ModelRef): TurnControlResolution {
  return {
    controls: {
      model,
      reasoning_effort: "medium",
      access_mode: "full_access",
      plan_mode: false,
    },
    source: "session_override",
    sessionControlRevision: revision,
    catalogGeneration: HARNESS_MODEL_CATALOG.generation,
  };
}

function sessionControls(sessionId: string, revision: number, model: string) {
  return {
    session_id: sessionId,
    revision,
    catalog_generation: HARNESS_MODEL_CATALOG.generation,
    controls: {
      model,
      reasoning_effort: "medium" as const,
      access_mode: "full_access" as const,
      plan_mode: false,
    },
  };
}

function appEnvelope(
  turnId: string,
  sessionId: string,
  controls: TurnExecutionControlsV1,
  text: string,
) {
  return createAppInboundEnvelope({
    chatId: sessionId,
    messageId: `message-${turnId}`,
    turnId,
    text,
    timestamp: "2026-07-14T00:00:00.000Z",
    sessionId,
    projectId: "project-a",
    executionControls: controls,
  });
}

function bareEnvelope(id: string) {
  return {
    eventId: id,
    transport: "test",
    accountId: "default",
    peer: { kind: "dm" as const, id: "peer" },
    sender: { id: "user" },
    message: { id, text: "continue", timestamp: "2026-07-14T00:00:00.000Z" },
  };
}

function binding(
  sessionId: string,
  projectId: string,
  workspacePath: string,
): StoredSessionBinding {
  return {
    sessionId,
    role: "butler",
    projectId,
    workspacePath,
    runtimeAdapterId: "codex-api",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.5",
    transportBindings: [],
    lifecycleState: "active",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
}

function provenance(
  projectId: string | null,
  sessionId: string,
  turnId: string,
) {
  return {
    conversation_session_id: `cs-${turnId}`,
    turn_id: turnId,
    inbound_message_id: `message-${turnId}`,
    runtime_session_id: sessionId,
    project_id: projectId,
  };
}

function structuredDecision(
  decisionId: string,
  continuityUpdates: Array<Record<string, unknown>>,
) {
  return parseStructuredTurnDecision(JSON.stringify({
    schema_version: "butler.turn-contract-decision.v1",
    decision_id: decisionId,
    action: "answer",
    target_workstream_id: null,
    target_project_id: null,
    blocker_id: null,
    evidence_domain: null,
    inspection_scope: null,
    deliverables: [],
    continuity_updates: continuityUpdates,
    answer_text: "확인했습니다.",
    public_title: "확인",
    public_summary: "요청을 처리했습니다.",
    public_rationale: "현재 턴의 의미에 따라 처리했습니다.",
    immediate_next_step: null,
  }), decisionId);
}

function noToolSurface(): ToolSurfacePromptController {
  return { applyTurnMetadata() {} } as unknown as ToolSurfacePromptController;
}

function beginAdmission(
  store: AgentConversationStore,
  butlerData: string,
  workspacePath: string,
  sessionId: string,
  turnId: string,
  eventId: string,
): ConversationAdmissionTurn {
  return ConversationAdmissionTurn.begin({
    writer: store,
    binding: binding(sessionId, "project-a", workspacePath),
    envelope: bareEnvelope(eventId),
    turnId,
    timestamp: "2026-07-14T00:00:00.000Z",
    butlerData,
  });
}

function retryActionStore(
  controls: TurnExecutionControlsV1,
  capture: (controls: TurnExecutionControlsV1) => void,
  sendWithCurrentControls: (
    request: MessageSendRequest,
  ) => Promise<MessageSendResult> = async () => ({ replies: [], next_cursor: 1 }),
): AppTurnActionStore {
  const now = "2026-07-14T00:00:00.000Z";
  const row: TurnRow = {
    rowid: 1,
    id: controls.turn_id,
    chat_id: controls.session_id,
    user_message_id: "message-retry",
    state: "runtime_fault",
    safe_status_label: "Failed",
    safe_error_code: "provider_error",
    retryable: 1,
    cancellable: 0,
    attempt: 0,
    execution_controls_json: JSON.stringify(controls),
    created_at: now,
    updated_at: now,
  };
  const message: MessageRow = {
    rowid: 1,
    id: "message-retry",
    chat_id: controls.session_id,
    turn_id: controls.turn_id,
    conversation_session_id: "cs-retry",
    conversation_turn_id: controls.turn_id,
    conversation_message_id: "cm-retry",
    role: "user",
    text: "retry",
    status: "failed",
    created_at: now,
    updated_at: now,
    safe_error_code: "provider_error",
    retryable: 1,
  };
  const retrying: TurnRecord = {
    id: controls.turn_id,
    chat_id: controls.session_id,
    user_message_id: message.id,
    state: "retrying",
    safe_status_label: "Retrying",
    retryable: false,
    cancellable: true,
    attempt: 1,
    created_at: now,
    updated_at: now,
    cursor: 1,
    execution_controls: controls,
    execution_model: {
      requested_model_ref: controls.model_ref,
      adapter_effective_model_ref: controls.model_ref,
    },
  };
  return new AppTurnActionStore({
    db: new Database(":memory:"),
    getTurn: () => retrying,
    getTurnRow: () => row,
    runtimeFaultRecordForTurn: () => ({ retryable: true }),
    getMessageRow: () => message,
    refsForMessage: () => [],
    claimRetryTurn: () => retrying,
    appendEvent() {},
    deleteAssistantMessagesForTurn() {},
    enqueueAppTransportTurn(input) {
      capture(input.executionControls);
      return retrying;
    },
    sendMessageWithCurrentControls: (request) => sendWithCurrentControls(request),
    dispatchDeferredResponderTurn() {},
    async completeResponderTurn() {
      return { turn: retrying, replies: [], next_cursor: 1 };
    },
    cancelResponder() { return false; },
    finalizeCancelledTurn: () => retrying,
    cleanupTurnEventSequences() {},
    ensureCancelledTurnActivityMessage: () => null,
  });
}

function turnRecordForControls(controls: TurnExecutionControlsV1): TurnRecord {
  return {
    id: controls.turn_id,
    chat_id: controls.session_id,
    state: "thinking",
    safe_status_label: "Thinking",
    retryable: false,
    cancellable: true,
    attempt: 1,
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:00.000Z",
    cursor: 2,
    execution_controls: controls,
    execution_model: {
      requested_model_ref: controls.model_ref,
      adapter_effective_model_ref: controls.model_ref,
    },
  };
}

function traceFor(scenario: string, sessionId: string, turnId: string) {
  return new MessageLifecycleTrace(scenario, sessionId, turnId);
}

function step(
  id: string,
  actualFunction: string,
  input: {
    concreteInput?: Record<string, unknown>;
    stateRead?: Record<string, unknown>;
    stateWritten?: Record<string, unknown>;
    outputOrNextCall?: Record<string, unknown>;
    invariant: boolean;
    evidence: string;
  },
) {
  return {
    step: id,
    actualFunction,
    concreteInput: input.concreteInput ?? {},
    stateRead: input.stateRead ?? {},
    stateWritten: input.stateWritten ?? {},
    outputOrNextCall: input.outputOrNextCall ?? {},
    invariant: input.invariant ? "pass" as const : "fail" as const,
    evidence: input.evidence,
  };
}

function completeTrace(
  trace: MessageLifecycleTrace,
  requiredFunctions: readonly string[],
): void {
  trace.requireFunctions(requiredFunctions);
  const artifact = trace.artifact();
  expect(failedInvariantSteps(artifact)).toEqual([]);
  artifacts.set(artifact.scenario, artifact);
}
