#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createBtccComposition } from "../../agent/composition/index.ts";
import type {
  BtccTurnCommand,
  ReasoningEffort,
} from "../../agent/btcc/index.ts";
import { DirectHarnessModel } from "./direct-harness-model.ts";
import { HarnessObservationExecutor } from "./harness-observation-executor.ts";
import { ManagedHarnessModel } from "./managed-harness-model.ts";
import {
  NoLedgerHarnessModel,
  type NoLedgerScenario,
} from "./no-ledger-harness-model.ts";

type HarnessOptions = {
  data: string;
  turnId: string;
  sessionId: string;
  message: string;
  provider: string;
  model: string;
  effort: ReasoningEffort;
  profileRefs: string[];
  feedbackRefs: string[];
  hotCacheRefs: string[];
  observationScopeRefs: string[];
  replay: boolean;
  scenario: "direct" | "managed-pass" | "managed-review-repair" | NoLedgerScenario;
};

async function runHarness(options: HarnessOptions): Promise<void> {
  const model = createHarnessModel(options.scenario);
  const operations = new HarnessObservationExecutor();
  const runtime = createBtccComposition({
    dbPath: join(options.data, "runtime", "btcc-successor.sqlite"),
    ownerId: `btcc-harness:${process.pid}`,
    model,
    operations,
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
  if (value === "managed-pass" || value === "managed-review-repair") return value;
  if (
    value === "direct-greeting" ||
    value === "direct-translation" ||
    value === "assisted-weather" ||
    value === "assisted-research"
  ) return value;
  throw new Error(`Invalid BTCC harness scenario: ${value}`);
}

function createHarnessModel(scenario: HarnessOptions["scenario"]) {
  if (scenario === "direct") return new DirectHarnessModel();
  if (scenario === "managed-pass" || scenario === "managed-review-repair") {
    return new ManagedHarnessModel(scenario === "managed-review-repair");
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
