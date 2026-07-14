import { describe, expect, test } from "bun:test";
import { EMPTY_MODEL_CATALOG } from "../../packages/butler-app/client/ui/src/app/constants.ts";
import { runtimeModels } from "../../packages/butler-app/client/ui/src/app/utils.ts";
import { createAppInboundEnvelope } from "../../packages/butler-agent/src/gateways/core/app-transport.ts";
import {
  failedInvariantSteps,
  MessageLifecycleTrace,
} from "../support/message-lifecycle-trace.ts";

const SESSION_ID = "project-simulation-sandy";
const TURN_ID = "turn-simulation-a";

describe("project turn lifecycle execution trace baseline", () => {
  test("records the real-model bootstrap placeholder failure through runtimeModels", () => {
    const models = runtimeModels(EMPTY_MODEL_CATALOG);
    const trace = new MessageLifecycleTrace(
      "bootstrap-model-placeholder-baseline",
      SESSION_ID,
      TURN_ID,
    );
    trace.record({
      step: "A1",
      actualFunction: "runtimeModels",
      concreteInput: {
        default_model_ref: EMPTY_MODEL_CATALOG.default_model_ref,
        model_count: EMPTY_MODEL_CATALOG.models.length,
      },
      stateRead: { catalog_source: "EMPTY_MODEL_CATALOG" },
      stateWritten: { renderer_model_ref: models[0]?.model_ref ?? null },
      outputOrNextCall: { next: "useComposerControls.applyControls" },
      invariant:
        models[0]?.model_ref === "openai/gpt-5.5" ? "fail" : "pass",
      evidence: "direct runtimeModels call",
    });

    const artifact = trace.artifact();
    expect(failedInvariantSteps(artifact).map((step) => step.step)).toEqual([
      "A1",
    ]);
    expect(artifact.steps[0]?.stateWritten.renderer_model_ref).toBe(
      "openai/gpt-5.5",
    );
  });

  test("records the accepted-turn control loss through createAppInboundEnvelope", () => {
    const envelope = createAppInboundEnvelope({
      chatId: SESSION_ID,
      messageId: "message-simulation-a",
      turnId: TURN_ID,
      text: "Keep this project instruction for the next relevant turn.",
      timestamp: "2026-07-14T00:00:00.000Z",
      sessionId: SESSION_ID,
      projectId: "sandy",
    });
    const trace = new MessageLifecycleTrace(
      "queued-turn-controls-baseline",
      SESSION_ID,
      TURN_ID,
    );
    trace.record({
      step: "B1",
      actualFunction: "createAppInboundEnvelope",
      concreteInput: {
        model_ref: "openai/gpt-5.6-sol",
        reasoning_effort: "medium",
      },
      stateRead: { routing_hints: envelope.routingHints ?? null },
      stateWritten: {
        execution_controls_present: "executionControls" in envelope,
      },
      outputOrNextCall: { next: "NativeInboundQueue.enqueue" },
      invariant: "executionControls" in envelope ? "pass" : "fail",
      evidence: "direct createAppInboundEnvelope call",
    });
    trace.requireFunctions(["createAppInboundEnvelope"]);

    const artifact = trace.artifact();
    expect(failedInvariantSteps(artifact).map((step) => step.step)).toEqual([
      "B1",
    ]);
  });

  test("rejects incomplete trace rows instead of accepting intuition", () => {
    const trace = new MessageLifecycleTrace(
      "trace-completeness",
      SESSION_ID,
      TURN_ID,
    );
    expect(() =>
      trace.record({
        step: "C1",
        actualFunction: "",
        concreteInput: {},
        stateRead: {},
        stateWritten: {},
        outputOrNextCall: {},
        invariant: "pass",
        evidence: "none",
      }),
    ).toThrow("message_trace_function_missing");
  });
});

