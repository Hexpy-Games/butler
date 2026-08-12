import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createProductionAgentAdapters } from
  "../../support/agent-benchmark/adapters.ts";
import type { BenchmarkArmPlan, BenchmarkFixture } from
  "../../support/agent-benchmark/contracts.ts";
import {
  preparedResourceDirectoryIdentity,
  type PreparedButlerResourceReference,
} from "../../support/agent-benchmark/prepared-butler-resource.ts";

const sourceRoot = process.env.BUTLER_RENDERER_SMOKE_SOURCE_ROOT;
const referenceJson = process.env.BUTLER_RENDERER_SMOKE_RESOURCE_REFERENCE;

test.skipIf(!sourceRoot || !referenceJson)(
  "production composition performs provider-free sequential renderer launches",
  async () => {
    const reference = JSON.parse(referenceJson!) as PreparedButlerResourceReference;
    const runRoot = process.env.BUTLER_RENDERER_SMOKE_RUN_ROOT;
    expect(runRoot).toBeTruthy();
    const evidenceRoot = join(runRoot!, "evidence");
    const before = preparedResourceDirectoryIdentity(reference.resourceDir);
    const result = await createProductionAgentAdapters(sourceRoot!, {
      preparedButlerResource: reference,
      rendererStartSmoke: true,
    }).butler.run({
      arm: arm(sourceRoot!, evidenceRoot, reference.sourceRevision),
      fixture: currentWebFixture(),
      prompt: "unused",
      sessionId: null,
      sourceEvidenceRoot: "",
      runtimeInstructions: "unused",
      signal: new AbortController().signal,
    });
    const after = preparedResourceDirectoryIdentity(reference.resourceDir);
    const evidence = JSON.parse(readFileSync(join(evidenceRoot, "evidence.json"), "utf8"));
    expect(result).toMatchObject({
      gateCode: "none", exitCode: 0, timedOut: false, cancelled: false,
    });
    expect(evidence).toMatchObject({
      kind: "launch_smoke", ok: true, observations: [], providerRequests: [],
      bundledAgentResource: { resourceSha256: reference.resourceSha256 },
    });
    expect(evidence.launches).toHaveLength(2);
    expect(evidence.launches.every((launch: { stoppedAtMs: number | null }) =>
      typeof launch.stoppedAtMs === "number")).toBe(true);
    expect(evidence.launches.every((launch: { electronPid: number; executorPid: number }) =>
      !processExists(launch.electronPid) && !processExists(launch.executorPid))).toBe(true);
    expect(existsSync(evidence.run.dataRoot)).toBe(false);
    expect(after).toEqual(before);
  },
  120_000,
);

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function arm(
  root: string,
  evidenceRoot: string,
  revision: string,
): BenchmarkArmPlan {
  return {
    key: "current-web-cold:controlled:butler:1", scenario: "current-web-cold",
    repetition: 1, order: 1, agent: "butler", track: "controlled", cache: "cold",
    fixtureHash: "renderer-smoke", sourceRoot: root,
    outputRoot: join(evidenceRoot, "..", "output"),
    dataRoot: join(evidenceRoot, "..", "benchmark-data"),
    evidenceRoot, cacheRoot: join(evidenceRoot, "..", "cache"),
    cachePairId: "current-web-cold:1", timeoutMs: 120_000,
    sourceRevision: revision,
    effectiveConfig: {
      model: "openai/gpt-5.6-sol", reasoning: "medium", permissions: "full_access",
      tools: [], memoryEnabled: null, skillsEnabled: null, pluginsEnabled: null,
      mcpEnabled: null, provider: "openai", variant: null,
    },
  };
}

function currentWebFixture(): BenchmarkFixture {
  return {
    id: "current-web-cold", version: "renderer-smoke", prompts: ["unused"],
    m1V2: {
      armId: "current-web-cold", targetStepId: "current-web-cold",
      publicBenchmarkFixture: true, promptSha256: {}, fixtureSha256: {},
      scenario: {
        schema: "butler.btcc-r3-electron-scenario.v1", id: "current-web-cold",
        model: "openai/gpt-5.6-sol", reasoningEffort: "medium",
        accessMode: "full_access", attributionArmId: "current-web-cold",
        session: { id: "current-web-cold-smoke", title: "Renderer smoke" },
        steps: [{ id: "current-web-cold", prompt: "unused" }],
      },
    },
  };
}
