import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createProductionBtccComposition } from "../../../../packages/butler-agent/src/agent/composition/index.ts";
import type {
  BtccTurnCommand,
  ButlerContextInput,
} from "../../../../packages/butler-agent/src/agent/btcc/index.ts";
import type {
  LiveScenario,
  ModelCell,
  ScenarioFixture,
  ScenarioObservation,
} from "../contracts.ts";
import type { LoadedFixtureCatalog } from "../fixtures/fixture-catalog.ts";
import { materializeScenario } from "../fixtures/materialize-scenario.ts";
import { seedAppProjectBinding } from "../fixtures/project-ledger-binding.ts";
import {
  readTurnObservation,
  snapshotFiles,
} from "../observations/read-turn-observation.ts";
import {
  seedProviderConfiguration,
  type LiveRunEnvironment,
} from "../environment/live-run-environment.ts";

export async function runLiveScenario(input: {
  environment: LiveRunEnvironment;
  scenario: LiveScenario;
  modelCell: ModelCell;
  catalog: LoadedFixtureCatalog;
}): Promise<ScenarioObservation> {
  const scenarioRoot = join(
    input.environment.runRoot,
    input.modelCell.id,
    input.scenario.scenarioId,
  );
  const fixture = materializeScenario({
    scenario: input.scenario,
    scenarioRoot,
    catalog: input.catalog,
  });
  seedProviderConfiguration(input.environment.sourceButlerData, fixture.butlerData);
  process.env.BUTLER_DATA = fixture.butlerData;
  const dbPath = join(fixture.butlerData, "runtime", "btcc-live.sqlite");
  seedAppProjectBinding({ dbPath, fixture });
  const composition = createProductionBtccComposition({
    butlerHome: process.env.BUTLER_HOME!,
    butlerData: fixture.butlerData,
    appMessageDbPath: dbPath,
    ownerId: `btcc-live-e2e:${process.pid}:${input.scenario.scenarioId}`,
  });
  const context = persistContext(fixture, composition.contextDocuments);
  const observations: ScenarioObservation["turns"] = [];
  let workspaceBefore = snapshotFiles(fixture.workspacePath);
  let previousTurnId: string | undefined;
  try {
    for (const step of input.scenario.turns) {
      const turnId = `${input.environment.runId}:${input.modelCell.id}:${step.stepId}`;
      let stopPromise: Promise<unknown> | undefined;
      let stopIssued = false;
      const stopObserving = composition.observeTurn(turnId, {
        stateChanged(update) {
          if (
            !stopIssued &&
            step.appActions.some((action) => action.kind === "ui_stop_active_turn") &&
            update.semanticState === "reporting"
          ) {
            stopIssued = true;
            stopPromise = composition.runtime.handle({ kind: "stop", turnId });
          }
        },
      });
      let outcome: Awaited<ReturnType<typeof composition.runtime.handle>> | undefined;
      let failure: unknown;
      try {
        const command = turnCommand({
          step,
          turnId,
          previousTurnId,
          fixture,
          context,
          modelCell: input.modelCell,
        });
        outcome = await composition.runtime.handle(command);
        await stopPromise;
      } catch (error) {
        failure = error;
      } finally {
        stopObserving();
      }
      const workspaceAfter = snapshotFiles(fixture.workspacePath);
      if (!existsSync(dbPath)) throw failure ?? new Error("BTCC production composition did not create its SQLite store");
      observations.push(readTurnObservation({
        dbPath,
        turnId,
        step,
        modelCell: input.modelCell,
        workspaceBefore,
        workspaceAfter,
        ...(outcome
          ? { outcome: { kind: outcome.kind, ...(outcome.kind === "delivered" ? { content: outcome.content } : {}) } }
          : {}),
        ...(failure ? { error: failure } : {}),
      }));
      workspaceBefore = workspaceAfter;
      previousTurnId = turnId;
    }
  } finally {
    composition.close();
  }
  const runtimeStatus = observations.every((turn) =>
    !turn.error && turn.runtimeChecks.every((check) => check.passed),
  ) ? "observed" : "failed";
  return {
    schema: "butler.btcc.live-diagnostic-row.v1",
    runId: input.environment.runId,
    scenarioId: input.scenario.scenarioId,
    modelCellId: input.modelCell.id,
    integrationSurface: "production_composition_runtime",
    fixtureCatalogSha256: input.catalog.sha256,
    turns: observations,
    runtimeStatus,
    proofEligible: false,
    proofGaps: [...new Set(observations.flatMap((turn) => turn.proofGaps))].sort(),
    preservedRoot: scenarioRoot,
  };
}

function persistContext(
  fixture: ScenarioFixture,
  documents: ReturnType<typeof createProductionBtccComposition>["contextDocuments"],
): ButlerContextInput {
  const userRef = "btcc-live-e2e-user";
  const persist = (
    projectionClass: "profile" | "recent_feedback" | "mandatory_hot_cache" | "optional_hot_cache",
    contents: string[],
  ) => contents.map((content, index) => documents.persist({
    scopeKind: "user",
    scopeId: userRef,
    projectionClass,
    sourceId: `btcc-live:${projectionClass}:${index}`,
    sourceRevision: digest(content),
    content,
  }));
  return {
    userRef,
    ...(fixture.projectRef ? { projectRef: fixture.projectRef } : {}),
    profileRefs: persist("profile", fixture.context.profile),
    recentFeedbackRefs: persist("recent_feedback", fixture.context.recentFeedback),
    mandatoryHotCacheRefs: persist("mandatory_hot_cache", fixture.context.mandatoryHotCache),
    optionalHotCacheRefs: persist("optional_hot_cache", fixture.context.optionalHotCache),
    baselineObservationScopeRefs: [
      `workspace:${fixture.workspacePath}`,
      "web:current",
      `memory:${userRef}`,
      ...(fixture.projectRef ? [`ledger:${fixture.projectRef}`] : []),
    ],
  };
}

function turnCommand(input: {
  step: LiveScenario["turns"][number];
  turnId: string;
  previousTurnId?: string;
  fixture: ScenarioFixture;
  context: ButlerContextInput;
  modelCell: ModelCell;
}): BtccTurnCommand {
  const modelSelection = {
    provider: input.modelCell.provider,
    model: input.modelCell.model,
    reasoningEffort: input.modelCell.reasoningEffort,
    controls: { source: "btcc_live_e2e_exact_cell" },
    controlsHash: digest({ source: "btcc_live_e2e_exact_cell" }),
  };
  if (input.step.inbound.kind === "authorized_continuation_wake") {
    if (!input.previousTurnId) throw new Error("Continuation wake has no source Turn");
    return {
      kind: "wake",
      turnId: input.turnId,
      sessionId: input.fixture.sessionId,
      triggerKey: input.step.stepId,
      trigger: {
        triggerId: input.step.inbound.readinessReceiptRef,
        sourceTurnId: input.previousTurnId,
        authorizationRef: input.step.inbound.authorizationRef,
        content: [
          "The declared external readiness condition is now satisfied.",
          `Continue the deferred goal from ${input.previousTurnId}.`,
          `Readiness receipt: ${input.step.inbound.readinessReceiptRef}.`,
        ].join(" "),
      },
      modelSelection,
      context: input.context,
    };
  }
  const content = inboundText(input.step, input.fixture);
  return {
    kind: "run",
    turnId: input.turnId,
    sessionId: input.fixture.sessionId,
    triggerKey: input.step.stepId,
    message: { messageId: `message:${input.step.stepId}`, content },
    modelSelection,
    context: input.context,
  };
}

function inboundText(step: LiveScenario["turns"][number], fixture: ScenarioFixture): string {
  if (step.inbound.kind === "inline_utf8") return step.inbound.text;
  if (step.inbound.kind === "authorized_continuation_wake") {
    throw new Error("Authorized wake is not an inline message");
  }
  const content = fixture.canonicalMessages.get(step.inbound.messageRef);
  if (!content) throw new Error(`Canonical fixture message is missing: ${step.inbound.messageRef}`);
  if (digest(content) !== step.inbound.contentSha256) {
    throw new Error(`Canonical fixture message hash mismatch: ${step.inbound.messageRef}`);
  }
  return content;
}

function digest(value: unknown): string {
  const bytes = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(bytes).digest("hex");
}
