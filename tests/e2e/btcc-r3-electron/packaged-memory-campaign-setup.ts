import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  BTCC_R3_ELECTRON_SCENARIO_SCHEMA,
} from "./contracts.ts";
import type {
  ElectronScenario,
  PreparedRun,
} from "./contracts.ts";
import type { ProductLaunch } from "./product-launch.ts";
import {
  capturePackagedPerformanceSnapshot,
  PACKAGED_PHYSICAL_PROCESS_ROLES,
  type PackagedPerformanceSnapshot,
  type PackagedProcessTarget,
} from "../../support/packaged-performance-snapshot.ts";
import { discoverPackagedProcessTargets } from "./packaged-memory-processes.ts";

export const DEFAULT_MODEL = "openai/gpt-5.6-sol";

export function createCampaignScenario(recallCycles: number): ElectronScenario {
  const responses = Array.from({ length: recallCycles }, (_, index) => [
    {
      requestKind: "agent" as const,
      responseModel: DEFAULT_MODEL,
      toolCall: {
        name: "recall_memory",
        arguments: {
          cue: `repeat-use memory campaign ${index}`,
          include_vector: true,
          strategies: ["search_vector_episode"],
        },
      },
    },
    {
      requestKind: "agent" as const,
      responseModel: DEFAULT_MODEL,
      text: "deterministic recall terminal",
    },
  ]).flat();
  return {
    schema: BTCC_R3_ELECTRON_SCENARIO_SCHEMA,
    id: "rmf-sc09-repeat-use",
    model: DEFAULT_MODEL,
    reasoningEffort: "low",
    accessMode: "full_access",
    providerFixture: {
      responses,
      defaultResponse: {
        requestKind: "agent",
        responseModel: DEFAULT_MODEL,
        text: "deterministic repeat-use terminal",
      },
    },
    session: { title: "RMF-SC09 repeat-use campaign" },
    steps: [],
  };
}

export async function seedLargeHistory(run: PreparedRun, count: number): Promise<void> {
  const { AppServerStore } = await import("../../../packages/butler-agent/src/gateways/app/application/store/app-server-store.ts");
  const store = new AppServerStore({
    dbPath: join(run.dataRoot, "app-server", "butler-client.sqlite"),
    butlerData: run.dataRoot,
    butlerHome: run.repoRoot,
  });
  try {
    const body = "history fixture ".repeat(32);
    for (let index = 0; index < count; index += 1) {
      store.insertMessage(
        run.sessionId,
        index % 2 === 0 ? "user" : "assistant",
        `${body}${index}`,
        "delivered",
      );
    }
  } finally {
    store.close();
  }
}

export function seedVectorFixture(run: PreparedRun): boolean {
  const source = join(run.sourceData, "cognition", "memory", "db", "butler.lance");
  const destination = join(run.dataRoot, "cognition", "memory", "db", "butler.lance");
  if (!existsSync(source)) return false;
  cpSync(source, destination, { recursive: true, force: false, errorOnExist: false });
  return existsSync(destination);
}

export function captureCampaignSnapshot(
  run: PreparedRun,
  processTargets: PackagedProcessTarget[],
  phase: "warmup" | "steady" | "idle",
  index: number,
  label: string,
): PackagedPerformanceSnapshot {
  return capturePackagedPerformanceSnapshot({
    butlerData: run.dataRoot,
    processTargets,
    cycle: { index, phase, label },
  });
}

export async function discoverCampaignWithRetry(
  run: Pick<PreparedRun, "dataRoot" | "debugPort">,
  launch: Pick<ProductLaunch, "child">,
): Promise<PackagedProcessTarget[]> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < 45_000) {
    try {
      const targets = discoverPackagedProcessTargets(run, launch);
      if (new Set(targets.map((target) => target.role)).size !== PACKAGED_PHYSICAL_PROCESS_ROLES.length) {
        throw new Error("required physical process roles are incomplete");
      }
      return targets;
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    }
  }
  throw new Error(`real packaged process roles were not discoverable: ${String(lastError)}`);
}
