#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createBtccComposition } from "../../agent/composition/index.ts";
import type {
  BtccTurnCommand,
  ReasoningEffort,
} from "../../agent/btcc/index.ts";
import { DirectHarnessModel } from "./direct-harness-model.ts";
import { HarnessArtifactWorkspace } from "./harness-artifact-workspace.ts";
import { HarnessOperationExecutor } from "./harness-operation-executor.ts";
import { ManagedHarnessModel } from "./managed-harness-model.ts";
import { RestartingManagedHarnessModel } from "./restarting-managed-harness-model.ts";
import {
  NoLedgerHarnessModel,
  type NoLedgerScenario,
} from "./no-ledger-harness-model.ts";

type HarnessOptions = {
  data: string;
  turnId: string;
  sessionId: string;
  projectRef?: string;
  message: string;
  provider: string;
  model: string;
  effort: ReasoningEffort;
  profileRefs: string[];
  feedbackRefs: string[];
  hotCacheRefs: string[];
  observationScopeRefs: string[];
  replay: boolean;
  scenario:
    | "direct"
    | "managed-pass"
    | "managed-review-repair"
    | "managed-planning-revision"
    | "managed-feedback-planning-revision"
    | "managed-governing-revision"
    | "managed-authority-revision"
    | "managed-artifact"
    | "managed-restart-once"
    | NoLedgerScenario;
};

async function runHarness(options: HarnessOptions): Promise<void> {
  const model = createHarnessModel(options.scenario, options.data);
  const operations = new HarnessOperationExecutor();
  const runtime = createBtccComposition({
    dbPath: join(options.data, "runtime", "btcc-successor.sqlite"),
    ownerId: `btcc-harness:${options.turnId}`,
    model,
    operations,
    artifacts: new HarnessArtifactWorkspace(),
  });
  const controls = { reasoningEffort: options.effort };
  const messageId = digest(`btcc-user-message.v1\0${options.sessionId}\0${options.message}`);
  const command: Extract<BtccTurnCommand, { kind: "run" }> = {
    kind: "run",
    turnId: options.turnId,
    sessionId: options.sessionId,
    triggerKey: `message:${messageId}`,
    message: { messageId, content: options.message },
    modelSelection: {
      provider: options.provider,
      model: options.model,
      reasoningEffort: options.effort,
      controls,
      controlsHash: digest(JSON.stringify(controls)),
    },
    context: {
      userRef: "user:off-production-harness",
      ...(options.projectRef ? { projectRef: options.projectRef } : {}),
      profileRefs: options.profileRefs,
      recentFeedbackRefs: options.feedbackRefs,
      mandatoryHotCacheRefs: options.hotCacheRefs,
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: options.observationScopeRefs,
    },
  };
  const initial = await runtime.handle(command);
  const replay = options.replay ? await runtime.handle(command) : initial;
  process.stdout.write(`${JSON.stringify({
    initial,
    replay,
    modelCalls: model.callCount,
    operationCalls: operations.callCount,
    phases: model.phases,
    selectedModel: {
      provider: command.modelSelection.provider,
      model: command.modelSelection.model,
      reasoningEffort: command.modelSelection.reasoningEffort,
    },
  })}\n`);
}

function parseOptions(argv: string[]): HarnessOptions {
  const values = new Map<string, string>();
  let replay = false;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--replay") {
      replay = true;
      continue;
    }
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid BTCC harness argument: ${key ?? "<missing>"}`);
    }
    values.set(key, value);
    index += 1;
  }
  const effort = required(values, "--effort");
  if (effort !== "low" && effort !== "medium" && effort !== "high" && effort !== "xhigh") {
    throw new Error(`Invalid reasoning effort: ${effort}`);
  }
  return {
    data: required(values, "--data"),
    turnId: required(values, "--turn"),
    sessionId: required(values, "--session"),
    projectRef: values.get("--project-ref"),
    message: required(values, "--message"),
    provider: required(values, "--provider"),
    model: required(values, "--model"),
    effort,
    profileRefs: optionalMany(values, "--profile-ref"),
    feedbackRefs: optionalMany(values, "--feedback-ref"),
    hotCacheRefs: optionalMany(values, "--hot-cache-ref"),
    observationScopeRefs: optionalMany(values, "--observation-scope"),
    replay,
    scenario: parseScenario(values.get("--scenario")),
  };
}

function parseScenario(value: string | undefined): HarnessOptions["scenario"] {
  if (value === undefined || value === "direct") return "direct";
  if (
    value === "managed-pass" ||
    value === "managed-review-repair" ||
    value === "managed-planning-revision" ||
    value === "managed-feedback-planning-revision" ||
    value === "managed-governing-revision" ||
    value === "managed-authority-revision" ||
    value === "managed-artifact" ||
    value === "managed-restart-once"
  ) return value;
  if (
    value === "direct-greeting" ||
    value === "direct-translation" ||
    value === "assisted-weather" ||
    value === "assisted-research"
  ) return value;
  throw new Error(`Invalid BTCC harness scenario: ${value}`);
}

function createHarnessModel(scenario: HarnessOptions["scenario"], dataRoot?: string) {
  if (scenario === "direct") return new DirectHarnessModel();
  if (scenario === "managed-restart-once") {
    if (!dataRoot) throw new Error("Restart scenario requires a data root");
    return new RestartingManagedHarnessModel(dataRoot);
  }
  if (
    scenario === "managed-pass" ||
    scenario === "managed-review-repair" ||
    scenario === "managed-planning-revision" ||
    scenario === "managed-feedback-planning-revision" ||
    scenario === "managed-governing-revision" ||
    scenario === "managed-authority-revision"
    || scenario === "managed-artifact"
  ) {
    return new ManagedHarnessModel(
      scenario !== "managed-pass" && scenario !== "managed-planning-revision",
      scenario === "managed-planning-revision",
      scenario === "managed-feedback-planning-revision",
      scenario === "managed-governing-revision"
        ? "governing_revision"
        : scenario === "managed-authority-revision"
          ? "authority_scope_revision"
          : "implementation_repair",
      scenario === "managed-artifact",
    );
  }
  return new NoLedgerHarnessModel(scenario);
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`Missing BTCC harness argument: ${key}`);
  return value;
}

function optionalMany(values: Map<string, string>, key: string): string[] {
  const value = values.get(key);
  return value ? [value] : [];
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

if (import.meta.main) {
  runHarness(parseOptions(process.argv.slice(2))).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
