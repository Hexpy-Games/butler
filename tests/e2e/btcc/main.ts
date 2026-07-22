import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  RunAggregate,
  ScenarioObservation,
} from "./contracts.ts";
import {
  canonicalProofGaps,
  checkLiveReadiness,
} from "./environment/check-live-readiness.ts";
import { prepareLiveRunEnvironment } from "./environment/live-run-environment.ts";
import { loadFixtureCatalog } from "./fixtures/fixture-catalog.ts";
import {
  loadLiveManifest,
  selectModelCells,
} from "./manifest/load-live-manifest.ts";
import {
  relativeReportPath,
  writeAggregateReport,
  writeScenarioReport,
} from "./reports/write-live-report.ts";
import { runLiveScenario } from "./runtime/run-live-scenario.ts";

const environment = prepareLiveRunEnvironment();
let exitCode: number;
try {
  const loaded = loadLiveManifest();
  if (process.argv.includes("--readiness")) {
    const readiness = checkLiveReadiness({
      environment,
      manifest: loaded.manifest,
      manifestPath: loaded.path,
      manifestSha256: loaded.sha256,
    });
    console.log(JSON.stringify(readiness, null, 2));
    exitCode = readiness.runtimeDiagnosticReady ? 0 : 1;
  } else {
    exitCode = await runMatrix({ environment, loaded });
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  exitCode = 1;
} finally {
  environment.restore();
}
process.exit(exitCode);

async function runMatrix(input: {
  environment: ReturnType<typeof prepareLiveRunEnvironment>;
  loaded: ReturnType<typeof loadLiveManifest>;
}): Promise<number> {
  const startedAt = new Date().toISOString();
  if (!input.environment.sourceTreeClean) {
    throw new Error(
      "BTCC live diagnostics require a clean feature worktree so the observed source revision is exact",
    );
  }
  const cellArgument = process.argv.includes("--matrix")
    ? "matrix"
    : process.argv.find((value) => value.startsWith("--cell="))?.slice("--cell=".length) ||
      process.env.BTCC_LIVE_MODEL_CELL;
  const modelCells = selectModelCells(cellArgument);
  const catalog = loadFixtureCatalog(input.loaded.manifest.scenarios);
  const rows: RunAggregate["rows"] = [];
  for (const modelCell of modelCells) {
    for (const scenario of input.loaded.manifest.scenarios) {
      let observation: ScenarioObservation;
      try {
        observation = await runLiveScenario({
          environment: input.environment,
          scenario,
          modelCell,
          catalog,
        });
      } catch (error) {
        observation = failedObservation({
          runId: input.environment.runId,
          runRoot: input.environment.runRoot,
          scenarioId: scenario.scenarioId,
          modelCellId: modelCell.id,
          fixtureCatalogSha256: catalog.sha256,
          error,
        });
      }
      const reportPath = writeScenarioReport(observation);
      rows.push({
        scenarioId: scenario.scenarioId,
        modelCellId: modelCell.id,
        status: observation.runtimeStatus,
        reportPath: relativeReportPath(input.environment.runRoot, reportPath),
      });
      console.log(JSON.stringify({
        scenarioId: scenario.scenarioId,
        modelCellId: modelCell.id,
        runtimeStatus: observation.runtimeStatus,
        proofEligible: false,
        reportPath,
      }));
    }
  }
  const aggregate: RunAggregate = {
    schema: "butler.btcc.live-diagnostic-aggregate.v1",
    runId: input.environment.runId,
    startedAt,
    completedAt: new Date().toISOString(),
    sourceRevision: input.environment.sourceRevision,
    manifestPath: input.loaded.path,
    manifestSha256: input.loaded.sha256,
    modelCells,
    expectedScenarioCount: input.loaded.manifest.scenarios.length * modelCells.length,
    observedRows: rows.length,
    rows,
    proofEligible: false,
    proofGaps: canonicalProofGaps(),
    outputRoot: input.environment.runRoot,
  };
  const reportPath = writeAggregateReport(aggregate);
  console.log(JSON.stringify({
    runtimeStatus: rows.every((row) => row.status === "observed") ? "observed" : "failed",
    proofEligible: false,
    reportPath,
    proofGaps: aggregate.proofGaps,
  }, null, 2));
  if (rows.some((row) => row.status === "failed")) return 1;
  return 0;
}

function failedObservation(input: {
  runId: string;
  runRoot: string;
  scenarioId: string;
  modelCellId: string;
  fixtureCatalogSha256: string;
  error: unknown;
}): ScenarioObservation {
  const preservedRoot = join(input.runRoot, input.modelCellId, input.scenarioId);
  mkdirSync(preservedRoot, { recursive: true });
  return {
    schema: "butler.btcc.live-diagnostic-row.v1",
    runId: input.runId,
    scenarioId: input.scenarioId,
    modelCellId: input.modelCellId,
    integrationSurface: "production_composition_runtime",
    fixtureCatalogSha256: input.fixtureCatalogSha256,
    turns: [],
    runtimeStatus: "failed",
    proofEligible: false,
    proofGaps: [
      ...canonicalProofGaps(),
      `scenario_runner_failed:${input.error instanceof Error ? input.error.message : String(input.error)}`,
    ],
    preservedRoot,
  };
}
