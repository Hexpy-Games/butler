import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveManifest, ModelCell } from "../contracts.ts";

export const EXACT_MODEL_CELLS: readonly ModelCell[] = [
  {
    id: "MODEL-OPENAI-GPT-5-6-SOL-LOW",
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "low",
  },
  {
    id: "MODEL-ZAI-GLM-5-2-MEDIUM",
    provider: "zai",
    model: "glm-5.2",
    reasoningEffort: "medium",
  },
];

export function authoritativeManifestPath(): string {
  return process.env.BTCC_LIVE_SCENARIO_MANIFEST?.trim() || join(
    process.env.HOME ?? "",
    ".butler",
    "project-ledger",
    "projects",
    "butler",
    "references",
    "btcc",
    "r00",
    "live-scenarios.v1.json",
  );
}

export function loadLiveManifest(): {
  manifest: LiveManifest;
  path: string;
  sha256: string;
} {
  const path = authoritativeManifestPath();
  const bytes = readFileSync(path);
  const manifest = JSON.parse(bytes.toString("utf8")) as LiveManifest;
  validateManifest(manifest);
  return { manifest, path, sha256: sha256(bytes) };
}

export function selectModelCells(argument: string | undefined): ModelCell[] {
  if (argument === "matrix") return [...EXACT_MODEL_CELLS];
  const match = EXACT_MODEL_CELLS.find((cell) => cell.id === argument);
  if (!match) throw new Error(`Unknown exact BTCC model cell: ${argument ?? "missing"}`);
  return [{ ...match }];
}

function validateManifest(manifest: LiveManifest): void {
  if (manifest.schema !== "butler.btcc.live-scenarios.v1") {
    throw new Error(`Unexpected live manifest schema: ${manifest.schema}`);
  }
  const ids = manifest.scenarios.map((scenario) => scenario.scenarioId);
  requireUnique(ids, "scenario id");
  if (JSON.stringify([...ids].sort()) !== JSON.stringify([...manifest.liveRequiredScenarioIds].sort())) {
    throw new Error("Live scenario set differs from liveRequiredScenarioIds");
  }
  if (ids.length !== manifest.expectedCounts.scenarioCount) {
    throw new Error("Live scenario count differs from expectedCounts");
  }
  const steps = manifest.scenarios.flatMap((scenario) => scenario.turns);
  requireUnique(steps.map((step) => step.stepId), "turn step id");
  if (steps.length !== manifest.expectedCounts.turnStepCount) {
    throw new Error("Live turn-step count differs from expectedCounts");
  }
  if (manifest.expectedCounts.modelCellCount !== EXACT_MODEL_CELLS.length) {
    throw new Error("Live model-cell count differs from the exact model contract");
  }
  if (
    manifest.expectedCounts.expectedLiveMatrixPairCount !==
      manifest.expectedCounts.scenarioCount * EXACT_MODEL_CELLS.length
  ) {
    throw new Error("Live matrix pair count is not the exact Cartesian product");
  }
  for (const step of steps) {
    if (step.inbound.kind !== "inline_utf8") continue;
    if (sha256(step.inbound.text) !== step.inbound.contentSha256) {
      throw new Error(`Inbound content hash mismatch: ${step.stepId}`);
    }
  }
}

function requireUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
