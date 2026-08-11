import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { M1V2CampaignConfig } from "./contracts.ts";
import type { loadCanonicalM1V2Fixtures } from "./fixtures.ts";

export function writeM1V2Manifest(
  outputRoot: string,
  config: M1V2CampaignConfig,
  fixtures: ReturnType<typeof loadCanonicalM1V2Fixtures>,
): M1V2Manifest {
  if (!config.sourceRevision || !/^[a-f0-9]{40}$/u.test(config.sourceRevision)) {
    throw new Error("M1 v2 source revision must be an exact 40-character Git SHA.");
  }
  const campaignId = randomUUID();
  const runs = fixtures.flatMap((fixture) =>
    Array.from({ length: config.repetitions }, (_, index) => {
      const repetition = index + 1;
      const repetitionKey = `rep-${String(repetition).padStart(2, "0")}`;
      return {
        armId: fixture.armId,
        repetition,
        runKey: `${fixture.armId}/${repetitionKey}`,
        scenarioId: `${fixture.scenario.id}-${campaignId.slice(0, 8)}-${repetitionKey}`,
        targetStepId: fixture.targetStepId,
        targetPromptSha256: fixture.promptSha256[fixture.targetStepId],
      };
    }));
  const manifest: M1V2Manifest = {
    schema: "butler.m1-v2-baseline-manifest.v1",
    campaignId,
    sourceRevision: config.sourceRevision,
    model: "openai/gpt-5.6-sol",
    reasoningEffort: "medium",
    fastMode: false,
    sequential: true,
    repetitionsPerArm: config.repetitions,
    retryPolicy: {
      providerApiMaxAttempts: 3,
      routeRetryCeiling: 3,
      retryContaminatedAccepted: false,
      replacementRunsAllowed: false,
    },
    cachePolicy: {
      directWarmSameSession: true,
      expectedObservedBoundaryMustMatch: true,
    },
    productPath: ["electron", "app", "session_actor", "btcc", "provider"],
    observerOnly: true,
    acceptanceRubric: {
      version: "spec-m1-context-efficiency-r2-v1",
      landingGrounding: [
        "butler.durable_project_work.v1",
        "butler.memory_context.v1",
        "butler.tools_workspace_authority.v1",
        "butler.provider_routing.v1",
        "butler.recovery.v1",
        "generic_copy_absent",
      ],
      allArmsSafety: [
        "duplicate_effect",
        "lost_correction",
        "lost_required_anchor",
        "workspace_authority",
        "work_stall",
        "database_integrity",
      ],
      unavailableFails: true,
    },
    fixtures: fixtures.map((fixture) => ({
      armId: fixture.armId,
      targetStepId: fixture.targetStepId,
      promptSha256: fixture.promptSha256,
      fixtureSha256: fixture.fixtureSha256,
    })),
    runs,
  };
  writeFileSync(join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return manifest;
}

export interface M1V2ManifestRun {
  armId: string;
  repetition: number;
  runKey: string;
  scenarioId: string;
  targetStepId: string;
  targetPromptSha256: string;
}

export interface M1V2Manifest {
  schema: "butler.m1-v2-baseline-manifest.v1";
  campaignId: string;
  sourceRevision: string;
  model: "openai/gpt-5.6-sol";
  reasoningEffort: "medium";
  fastMode: false;
  sequential: true;
  repetitionsPerArm: number;
  retryPolicy: Record<string, number | boolean>;
  cachePolicy: Record<string, boolean>;
  productPath: string[];
  observerOnly: true;
  acceptanceRubric: {
    version: string;
    landingGrounding: string[];
    allArmsSafety: string[];
    unavailableFails: true;
  };
  fixtures: Array<Record<string, unknown>>;
  runs: M1V2ManifestRun[];
}
