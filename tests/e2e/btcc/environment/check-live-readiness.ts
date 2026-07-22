import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProductionBtccComposition } from "../../../../packages/butler-agent/src/agent/composition/index.ts";
import type { LiveManifest } from "../contracts.ts";
import { loadFixtureCatalog } from "../fixtures/fixture-catalog.ts";
import { materializeScenario } from "../fixtures/materialize-scenario.ts";
import {
  resolveFixtureProjectLedger,
  seedAppProjectBinding,
} from "../fixtures/project-ledger-binding.ts";
import { EXACT_MODEL_CELLS, sha256 } from "../manifest/load-live-manifest.ts";
import {
  providerReadiness,
  type LiveRunEnvironment,
} from "./live-run-environment.ts";

const CANONICAL_PROOF_GAPS = [
  "generated_diagnostic_fixtures_are_not_canonical_fixture_snapshots",
  "installed_app_ui_driver_is_not_bound_to_this_runner",
  "production_composition_does_not_expose_every_provider_call_identity",
  "canonical_goal_effect_artifact_checkpoint_assertion_resolvers_are_absent",
] as const;

export function checkLiveReadiness(input: {
  environment: LiveRunEnvironment;
  manifest: LiveManifest;
  manifestPath: string;
  manifestSha256: string;
}) {
  let fixtureCatalog: { ready: boolean; detail: string; sha256?: string };
  try {
    const catalog = loadFixtureCatalog(input.manifest.scenarios);
    for (const scenario of input.manifest.scenarios) {
      const fixture = materializeScenario({
        scenario,
        scenarioRoot: join(input.environment.runRoot, "readiness-fixtures", scenario.scenarioId),
        catalog,
      });
      const appDbPath = join(fixture.butlerData, "runtime", "btcc-live.sqlite");
      seedAppProjectBinding({ dbPath: appDbPath, fixture });
      const projectLedger = resolveFixtureProjectLedger({ dbPath: appDbPath, fixture });
      if (fixture.projectRef && !projectLedger?.initialized) {
        throw new Error(`Production Project Ledger resolver rejected: ${scenario.scenarioId}`);
      }
      for (const turn of scenario.turns) {
        if (turn.inbound.kind !== "canonical_local_ref") continue;
        const content = fixture.canonicalMessages.get(turn.inbound.messageRef);
        if (!content || sha256(content) !== turn.inbound.contentSha256) {
          throw new Error(`Canonical fixture message mismatch: ${turn.inbound.messageRef}`);
        }
      }
    }
    fixtureCatalog = { ready: true, detail: catalog.path, sha256: catalog.sha256 };
  } catch (error) {
    fixtureCatalog = {
      ready: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const providers = EXACT_MODEL_CELLS.map((cell) => ({
    modelCellId: cell.id,
    ...providerReadiness(cell, input.environment.sourceButlerData),
  }));
  const productionCompositionCallable = typeof createProductionBtccComposition === "function";
  const runtimeBlockers = [
    ...(!fixtureCatalog.ready ? [`fixture_catalog:${fixtureCatalog.detail}`] : []),
    ...providers.filter((provider) => !provider.ready)
      .map((provider) => `provider:${provider.modelCellId}:${provider.detail}`),
    ...(!productionCompositionCallable ? ["production_composition_unavailable"] : []),
    ...(!input.environment.sourceTreeClean ? ["feature_worktree_is_dirty"] : []),
  ];
  const runtimeDiagnosticReady = fixtureCatalog.ready &&
    productionCompositionCallable &&
    providers.every((provider) => provider.ready) &&
    input.environment.sourceTreeClean;
  const result = {
    schema: "butler.btcc.live-diagnostic-readiness.v1",
    runId: input.environment.runId,
    sourceRevision: input.environment.sourceRevision,
    sourceTreeClean: input.environment.sourceTreeClean,
    manifestPath: input.manifestPath,
    manifestSha256: input.manifestSha256,
    scenarioCount: input.manifest.scenarios.length,
    turnStepCount: input.manifest.scenarios.flatMap((scenario) => scenario.turns).length,
    fixtureCatalog,
    providers,
    productionCompositionCallable,
    runtimeBlockers,
    runtimeDiagnosticReady,
    canonicalProofReady: false,
    canonicalProofGaps: CANONICAL_PROOF_GAPS,
    outputRoot: input.environment.runRoot,
  };
  const reportPath = join(input.environment.runRoot, "readiness.json");
  writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return { ...result, reportPath };
}

export function canonicalProofGaps(): string[] {
  return [...CANONICAL_PROOF_GAPS];
}
