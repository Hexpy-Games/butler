import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TURN_INTERRUPTION_PRODUCER_COUNT,
  TURN_INTERRUPTION_PRODUCERS,
  validateTurnInterruptionProducerRegistry,
} from "../../packages/butler-agent/src/agent/turn/interruption/turn-interruption-producer-registry.ts";
import { TURN_OUTCOMES } from "../../packages/butler-agent/src/agent/events/turn-state-contract.ts";
import { appSafeResponderError } from "../../packages/butler-agent/src/gateways/app/infrastructure/transport/failure-ux-contract.ts";
import { projectSafeTurnFailure } from "../../packages/butler-agent/src/gateways/app/infrastructure/transport/turn-failure-projection.ts";
import { safeRuntimeFailure } from "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import {
  failedInvariantSteps,
  MessageLifecycleTrace,
} from "../support/message-lifecycle-trace.ts";

const AGENT_SOURCE = join(process.cwd(), "packages", "butler-agent", "src");

describe("current turn interruption producer registry", () => {
  test("enumerates every known generic terminal producer with stable typed ownership", () => {
    expect(() => validateTurnInterruptionProducerRegistry()).not.toThrow();
    expect(TURN_INTERRUPTION_PRODUCERS).toHaveLength(
      TURN_INTERRUPTION_PRODUCER_COUNT,
    );
    expect(new Set(TURN_INTERRUPTION_PRODUCERS.map((item) => item.id)).size)
      .toBe(TURN_INTERRUPTION_PRODUCER_COUNT);
    expect(new Set(TURN_INTERRUPTION_PRODUCERS.flatMap((item) => item.entryRoots)))
      .toEqual(new Set(["app", "queued", "direct", "system", "automation", "recovery", "legacy"]));
    expect(TURN_INTERRUPTION_PRODUCERS.filter((item) => item.migrationStatus === "routed")
      .map((item) => item.id)).toEqual(["native_turn_catch"]);
  });

  test("registry boundaries still exist in the current production modules", () => {
    for (const item of TURN_INTERRUPTION_PRODUCERS) {
      const source = readFileSync(join(AGENT_SOURCE, item.modulePath), "utf8");
      expect(source, `${item.id}:${item.modulePath}`).toContain(item.boundary);
    }
  });

  test("records executable red evidence for the current failure-state contract", () => {
    const unknown = safeRuntimeFailure(new Error("unclassified baseline interruption"));
    const projected = projectSafeTurnFailure({ message: {}, metadata: {} });
    const timeout = new Error("responder timeout baseline");
    timeout.name = "AppResponderTimeoutError";
    const responder = appSafeResponderError(timeout);
    const trace = new MessageLifecycleTrace(
      "current-generic-failure-authority",
      "session-baseline",
      "turn-baseline",
    );

    trace.record({
      step: "1",
      actualFunction: "safeRuntimeFailure",
      concreteInput: { error_kind: "unknown" },
      stateRead: {},
      stateWritten: { safe_error_code: unknown.code },
      outputOrNextCall: { message: unknown.message },
      invariant: unknown.code === "gateway_failed" ? "fail" : "pass",
      evidence: "direct provider error normalization call",
    });
    trace.record({
      step: "2",
      actualFunction: "projectSafeTurnFailure",
      concreteInput: { metadata_present: false },
      stateRead: {},
      stateWritten: { projected_code: projected.code },
      outputOrNextCall: { message: projected.message },
      invariant: projected.code === "gateway_failed" ? "fail" : "pass",
      evidence: "direct App failure projection call",
    });
    trace.record({
      step: "3",
      actualFunction: "appSafeResponderError",
      concreteInput: { error_name: timeout.name },
      stateRead: {},
      stateWritten: { projected_code: responder.code },
      outputOrNextCall: { message: responder.message },
      invariant: responder.code === "gateway_timeout" ? "fail" : "pass",
      evidence: "direct responder timeout projection call",
    });
    trace.record({
      step: "4",
      actualFunction: "TURN_OUTCOMES",
      concreteInput: {},
      stateRead: { outcomes: [...TURN_OUTCOMES] },
      stateWritten: {},
      outputOrNextCall: { next: "createTurnOutcomePayload" },
      invariant: TURN_OUTCOMES.some((value) => value === "failed" || value === "runtime_fault")
        ? "fail"
        : "pass",
      evidence: "direct canonical event contract inspection",
    });

    const artifact = trace.artifact();
    trace.requireFunctions([
      "safeRuntimeFailure",
      "projectSafeTurnFailure",
      "appSafeResponderError",
      "TURN_OUTCOMES",
    ]);
    expect(failedInvariantSteps(artifact).map((step) => step.step))
      .toEqual(["1", "2", "3", "4"]);
  });

  test("registry validation rejects duplicate and ownerless producers", () => {
    expect(() => validateTurnInterruptionProducerRegistry([
      TURN_INTERRUPTION_PRODUCERS[0],
      TURN_INTERRUPTION_PRODUCERS[0],
    ])).toThrow("turn_interruption_producer_id_duplicate");

    expect(() => validateTurnInterruptionProducerRegistry([{
      ...TURN_INTERRUPTION_PRODUCERS[0],
      id: "ownerless",
      entryRoots: [],
    }])).toThrow("turn_interruption_producer_entry_root_missing");
  });
});
