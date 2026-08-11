import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { M1V2CampaignConfig } from "./contracts.ts";
import type { loadCanonicalM1V2Fixtures } from "./fixtures.ts";

export function writeM1V2Manifest(
  outputRoot: string,
  config: M1V2CampaignConfig,
  fixtures: ReturnType<typeof loadCanonicalM1V2Fixtures>,
): void {
  if (config.sourceRevision && !/^[a-f0-9]{7,64}$/iu.test(config.sourceRevision)) {
    throw new Error("M1 v2 source revision must be a hexadecimal Git revision.");
  }
  writeFileSync(join(outputRoot, "manifest.json"), `${JSON.stringify({
    schema: "butler.m1-v2-baseline-manifest.v1",
    sourceRevision: config.sourceRevision ?? null,
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
    fixtures: fixtures.map((fixture) => ({
      armId: fixture.armId,
      targetStepId: fixture.targetStepId,
      promptSha256: fixture.promptSha256,
      fixtureSha256: fixture.fixtureSha256,
    })),
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
