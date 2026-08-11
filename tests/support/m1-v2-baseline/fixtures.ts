import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronScenario } from "../../e2e/btcc-r3-electron-harness.ts";
import type { CanonicalM1V2Fixture, M1V2ArmId } from "./contracts.ts";

const DEFINITIONS: Array<{
  armId: M1V2ArmId;
  file: string;
  targetStepId: string;
  promptSha256: Record<string, string>;
  fixtureSha256?: Record<string, string>;
}> = [
  {
    armId: "direct-cold",
    file: "direct-cold.json",
    targetStepId: "direct-cold",
    promptSha256: {
      "direct-cold": "3235f8b0c1704899168c9da7ed0cf466b052873f74fb0fe7e40cd95138a9c827",
    },
  },
  {
    armId: "direct-warm",
    file: "direct-warm.json",
    targetStepId: "direct-warm",
    promptSha256: {
      warmup: "3235f8b0c1704899168c9da7ed0cf466b052873f74fb0fe7e40cd95138a9c827",
      "direct-warm": "1c77b5e04e4e0539ee73078e5594ddbdec2a4feecac5889aaffc977c5ef1684b",
    },
  },
  {
    armId: "current-web-cold",
    file: "current-web-cold.json",
    targetStepId: "current-web-cold",
    promptSha256: {
      "current-web-cold": "1a005e359be608b217f2f7b9d11831fc96357be514a1b29b5f66441b4d293f2b",
    },
  },
  {
    armId: "landing-cold",
    file: "landing-cold.json",
    targetStepId: "landing-cold",
    promptSha256: {
      "landing-cold": "13abcbe43bb495137e2f01c9c2e824211dae7b189361fa3b2141b64781a054ff",
    },
    fixtureSha256: {
      "package.json": "95ecbc5ceb44f1aef70447a3f32a53875f6ac518b3b6cc47d173cb6be7b15acc",
      "index.html": "a63afd07e728a2055133510f0cc1ad65140dd25ec495d342d6cce2e55d157dc1",
      "styles.css": "f5fcb45b67a99855be1a908025d8bbdd3685c788f1ee391e741c9d988629dcd1",
    },
  },
];

export function loadCanonicalM1V2Fixtures(repoRoot: string): CanonicalM1V2Fixture[] {
  return DEFINITIONS.map((definition) => {
    const path = join(
      repoRoot,
      "tests/support/m1-v2-baseline/fixtures",
      definition.file,
    );
    const scenario = JSON.parse(readFileSync(path, "utf8")) as ElectronScenario;
    if (
      scenario.model !== "openai/gpt-5.6-sol" ||
      scenario.reasoningEffort !== "medium" ||
      scenario.attributionArmId !== definition.armId
    ) throw new Error(`Canonical M1 v2 fixture metadata drifted: ${definition.armId}`);
    for (const step of scenario.steps) {
      if (digest(step.prompt) !== definition.promptSha256[step.id]) {
        throw new Error(`Canonical M1 v2 prompt bytes drifted: ${definition.armId}/${step.id}`);
      }
    }
    const fixtureSha256 = definition.fixtureSha256 ?? {};
    for (const fixture of scenario.fixtures ?? []) {
      if (digest(fixture.text) !== fixtureSha256[fixture.path]) {
        throw new Error(`Canonical M1 v2 landing fixture bytes drifted: ${fixture.path}`);
      }
    }
    return {
      armId: definition.armId,
      scenario,
      targetStepId: definition.targetStepId,
      publicBenchmarkFixture: true,
      promptSha256: { ...definition.promptSha256 },
      fixtureSha256: { ...fixtureSha256 },
    };
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
