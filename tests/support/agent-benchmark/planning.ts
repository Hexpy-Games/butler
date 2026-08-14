import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  AGENT_BENCHMARK_BASELINE_SHA,
  AGENT_BENCHMARK_SCHEMA,
  type BenchmarkAgent,
  type BenchmarkCampaign,
  type BenchmarkArmPlan,
  type BenchmarkCacheState,
  type BenchmarkPlan,
  type BenchmarkScenario,
  type BenchmarkTrack,
} from "./contracts.ts";
import {
  AGENT_BENCHMARK_FIXTURES,
  hashBenchmarkFixture,
  loadM1V2BenchmarkFixtures,
  summarizeBenchmarkFixture,
} from "./fixtures.ts";
import { sanitizeIdentifier } from "./identifiers.ts";
import { effectiveAgentConfig } from "./track-config.ts";
import { verifyM1V2AuthoritativeProvenance } from "./m1-v2-provenance.ts";
import { validatePairedCampaignContract, type PairedCampaignContract } from "./paired-contract.ts";
import { validateAfterOnlyCampaignContract, type AfterOnlyCampaignContract } from "./after-only-contract.ts";

export const BENCHMARK_AGENTS: readonly BenchmarkAgent[] = ["butler", "hermes", "opencode"];
/** Tracks that are materialized by the compact pilot. The recommended-default
 * configuration remains a supported definition, but it is intentionally not
 * an execution arm or separately verified configuration in this pilot.
 */
export const BENCHMARK_TRACKS: readonly BenchmarkTrack[] = [
  "controlled",
];
export const BENCHMARK_SUPPORTED_TRACKS: readonly BenchmarkTrack[] = [
  "controlled",
  "recommended-default",
];
export const BENCHMARK_CACHE_STATES: readonly BenchmarkCacheState[] = [
  "cold",
  "warm",
];
export const DEFAULT_BENCHMARK_TIMEOUT_MS = 15 * 60 * 1_000;
export interface CreateBenchmarkPlanInput {
  campaign?: BenchmarkCampaign;
  runId: string;
  seed: number;
  runRoot: string;
  sourceRoot: string;
  harnessRoot?: string;
  provenanceJsonlPath?: string;
  baselineSha?: string;
  controlledModel: string;
  controlledReasoning?: string;
  repetitionsPerCache?: number;
  createdAt?: string;
  preparedButlerResource?: BenchmarkPlan["preparedButlerResource"];
  pairedCampaign?: PairedCampaignContract;
  pairedRuntimeSources?: Readonly<Record<"before" | "after", string>>;
  afterOnlyCampaign?: AfterOnlyCampaignContract;
}

export function createBenchmarkPlan(input: CreateBenchmarkPlanInput): BenchmarkPlan {
  assertSeed(input.seed);
  const runId = sanitizeIdentifier(input.runId);
  if (!runId) throw new Error("runId must be a safe benchmark identifier");
  const campaign = input.campaign ?? "cross-agent-pilot";
  const baselineSha = input.baselineSha ?? AGENT_BENCHMARK_BASELINE_SHA;
  if (campaign === "cross-agent-pilot" && baselineSha !== AGENT_BENCHMARK_BASELINE_SHA) {
    throw new Error(
      `Benchmark baseline must be origin/main ${AGENT_BENCHMARK_BASELINE_SHA}; received ${baselineSha}`,
    );
  }
  if (!/^[a-f0-9]{40}$/u.test(baselineSha)) throw new Error("Benchmark source revision must be an exact Git SHA");
  const m1Campaign = campaign === "m1-v2" || campaign === "m1-v2-paired" || campaign === "m1-v2-after-only";
  const repetitionsPerCache = input.repetitionsPerCache ?? (m1Campaign ? 3 : 1);
  if (campaign === "cross-agent-pilot" && repetitionsPerCache !== 1) {
    throw new Error("The canonical pilot uses exactly one repetition per scenario");
  }
  const runRoot = resolve(input.runRoot);
  const sourceRoot = resolve(input.sourceRoot);
  const harnessRoot = resolve(input.harnessRoot ?? input.sourceRoot);
  if (m1Campaign && (repetitionsPerCache < 3 || repetitionsPerCache > 10)) {
    throw new Error("M1 v2 repetitions must be an integer between 3 and 10");
  }
  if (m1Campaign && !input.harnessRoot) {
    throw new Error("M1 v2 requires an explicit harness authority root.");
  }
  if (m1Campaign && !input.provenanceJsonlPath) {
    throw new Error("M1 v2 requires the authoritative provenance JSONL path.");
  }
  if (campaign === "m1-v2-paired" && (!input.pairedCampaign || !input.pairedRuntimeSources)) {
    throw new Error("M1 v2 paired requires its immutable campaign contract and both runtime sources.");
  }
  if (input.pairedCampaign) validatePairedCampaignContract(input.pairedCampaign);
  if (campaign === "m1-v2-after-only" && !input.afterOnlyCampaign) {
    throw new Error("M1 v2 AFTER-only requires its frozen BEFORE campaign contract.");
  }
  if (input.afterOnlyCampaign) validateAfterOnlyCampaignContract(input.afterOnlyCampaign);
  const verifiedProvenance = m1Campaign
    ? verifyM1V2AuthoritativeProvenance({
        repoRoot: harnessRoot,
        jsonlPath: resolve(input.provenanceJsonlPath!),
      })
    : null;
  if (input.pairedCampaign &&
      JSON.stringify(input.pairedCampaign.provenance) !== JSON.stringify(verifiedProvenance?.identity)) {
    throw new Error("Paired campaign provenance must equal the freshly verified top-level provenance authority.");
  }
  if (input.afterOnlyCampaign &&
      JSON.stringify(input.afterOnlyCampaign.provenance) !== JSON.stringify(verifiedProvenance?.identity)) {
    throw new Error("AFTER-only campaign provenance must equal the freshly verified top-level provenance authority.");
  }
  const campaignFixtures = m1Campaign
    ? loadM1V2BenchmarkFixtures(harnessRoot)
    : AGENT_BENCHMARK_FIXTURES;
  const fixtures = campaignFixtures.map(summarizeBenchmarkFixture);
  const arms: BenchmarkArmPlan[] = [];
  let order = 0;
  const track: BenchmarkTrack = "controlled";
  if (campaign === "m1-v2-paired" || campaign === "m1-v2-after-only") {
    const steps = campaign === "m1-v2-paired" ? input.pairedCampaign!.steps : input.afterOnlyCampaign!.steps;
    const fixtureById = new Map(campaignFixtures.map((fixture) => [fixture.id, fixture]));
    for (const step of steps) {
      const fixture = fixtureById.get(step.fixture);
      if (!fixture || hashBenchmarkFixture(fixture) !== step.fixtureSha256) {
        throw new Error(`Paired fixture identity mismatch: ${step.fixture}`);
      }
      const armRoot = join(runRoot, "arms", `block-${step.block}`, step.version);
      arms.push({
        key: step.key, scenario: step.fixture, repetition: step.repetition,
        order: step.order, agent: "butler", track, cache: step.fixture === "direct-warm" ? "warm" : "cold",
        fixtureHash: step.fixtureSha256,
        effectiveConfig: effectiveAgentConfig("butler", track, input),
        sourceRoot: campaign === "m1-v2-paired" ? resolve(input.pairedRuntimeSources![step.version]) : sourceRoot,
        outputRoot: join(armRoot, "output"), dataRoot: join(armRoot, "data"),
        evidenceRoot: join(armRoot, "evidence"), cacheRoot: join(runRoot, "cache", step.pairId, step.version),
        cachePairId: step.pairId, timeoutMs: DEFAULT_BENCHMARK_TIMEOUT_MS,
        sourceRevision: step.source.revision, version: step.version,
        pairId: step.pairId, block: step.block,
        pairedExecution: campaign === "m1-v2-paired" ? input.pairedCampaign!.execution : input.afterOnlyCampaign!.execution,
        activation: step.source.activation,
      });
    }
  } else for (const fixture of campaignFixtures) {
    for (let repetition = 1; repetition <= repetitionsPerCache; repetition += 1) {
    const randomizedAgents = seededShuffle(
      campaign === "m1-v2" ? (["butler"] as const) : BENCHMARK_AGENTS,
      deriveArmSeed(input.seed, fixture.id, track, "cold", repetition),
    );
    const cacheStates: readonly BenchmarkCacheState[] = campaign === "m1-v2"
      ? [fixture.id === "direct-warm" ? "warm" : "cold"]
      : fixture.id === "direct_conversation"
      ? ["cold", "warm"]
      : ["cold"];
    for (const agent of randomizedAgents) {
      for (const cache of cacheStates) {
        const fixtureHash = hashBenchmarkFixture(fixture);
        const key = `${fixture.id}:${track}:${agent}:${cache}:${repetition}`;
        const cachePairId = `${fixture.id}:${track}:${agent}:${repetition}`;
        const cacheRoot = join(
          runRoot,
          "cache",
          safeSegment(fixture.id),
          safeSegment(track),
          safeSegment(agent),
          `rep-${repetition}`,
        );
        const armRoot = join(
          runRoot,
          "arms",
          safeSegment(fixture.id),
          safeSegment(track),
          `rep-${repetition}`,
          safeSegment(agent),
          safeSegment(cache),
        );
        arms.push({
          key,
          scenario: fixture.id,
          repetition,
          order,
          agent,
          track,
          cache,
          fixtureHash,
          effectiveConfig: effectiveAgentConfig(agent, track, input),
          sourceRoot,
          outputRoot: join(armRoot, "output"),
          dataRoot: join(armRoot, "data"),
          evidenceRoot: join(armRoot, "evidence"),
          cacheRoot,
          cachePairId,
          timeoutMs: DEFAULT_BENCHMARK_TIMEOUT_MS,
          sourceRevision: baselineSha,
        });
        order += 1;
      }
    }
    }
  }
  const plan: BenchmarkPlan = {
    schema: AGENT_BENCHMARK_SCHEMA,
    kind: "agent_benchmark_plan",
    campaign,
    runId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    seed: input.seed,
    baselineSha,
    runRoot,
    sourceRoot,
    harnessRoot,
    ...(m1Campaign ? {
      provenanceJsonlPath: resolve(input.provenanceJsonlPath!),
      provenance: verifiedProvenance!.identity,
    } : {}),
    ...(input.preparedButlerResource ? { preparedButlerResource: { ...input.preparedButlerResource } } : {}),
    ...(input.pairedCampaign ? { pairedCampaign: input.pairedCampaign } : {}),
    ...(input.afterOnlyCampaign ? { afterOnlyCampaign: input.afterOnlyCampaign } : {}),
    tracks: BENCHMARK_TRACKS,
    fixtures,
    ...(m1Campaign ? { policy: {
      sequential: true as const,
      observerOnly: true as const,
      retryContaminatedAccepted: false as const,
      replacementRunsAllowed: false as const,
      directWarmSameSession: true as const,
      expectedObservedCacheBoundaryMustMatch: true as const,
      rubricVersion: "spec-m1-context-efficiency-r2-v1",
    } } : {}),
    arms,
  };
  plan.planIdentity = computeBenchmarkPlanSemanticIdentity(plan);
  plan.arms = plan.arms.map((arm) => ({ ...arm, planIdentity: plan.planIdentity }));
  return plan;
}

/** Stable identity for checkpoint resume; excludes only volatile createdAt. */
export function benchmarkPlanIdentity(
  plan: Pick<BenchmarkPlan, "campaign" | "runId" | "seed" | "baselineSha" | "runRoot" | "sourceRoot" | "harnessRoot" | "provenanceJsonlPath" | "provenance" | "preparedButlerResource" | "pairedCampaign" | "afterOnlyCampaign" | "tracks" | "fixtures" | "arms" | "policy" | "planIdentity">,
): string {
  const computed = computeBenchmarkPlanSemanticIdentity(plan);
  if (plan.planIdentity !== undefined && plan.planIdentity !== computed) {
    throw new Error("Benchmark plan carried identity mismatch.");
  }
  const identity = plan.planIdentity ?? computed;
  if (plan.arms.some((arm) => arm.planIdentity !== undefined && arm.planIdentity !== identity)) {
    throw new Error("Benchmark arm carried identity mismatch.");
  }
  return identity;
}

function computeBenchmarkPlanSemanticIdentity(
  plan: Pick<BenchmarkPlan, "campaign" | "runId" | "seed" | "baselineSha" | "runRoot" | "sourceRoot" | "harnessRoot" | "provenanceJsonlPath" | "provenance" | "preparedButlerResource" | "pairedCampaign" | "afterOnlyCampaign" | "tracks" | "fixtures" | "arms" | "policy">,
): string {
  const publicPath = (path: string) => (isAbsolute(path) ? relative(plan.runRoot, path) : path).replaceAll("\\", "/");
  const publicArm = (arm: BenchmarkArmPlan) => ({
      key: arm.key,
      scenario: arm.scenario,
      repetition: arm.repetition,
      order: arm.order,
      agent: arm.agent,
      track: arm.track,
      cache: arm.cache,
      fixtureHash: arm.fixtureHash,
      effectiveConfig: arm.effectiveConfig,
      sourceRoot: `<${arm.version ?? "source"}-source-root>`,
      outputRoot: publicPath(arm.outputRoot),
      dataRoot: publicPath(arm.dataRoot),
      evidenceRoot: publicPath(arm.evidenceRoot),
      cacheRoot: publicPath(arm.cacheRoot),
      cachePairId: arm.cachePairId,
      timeoutMs: arm.timeoutMs,
      sourceRevision: arm.sourceRevision,
      version: arm.version ?? null,
      ...(arm.activation ? { activation: arm.activation } : {}),
      pairId: arm.pairId ?? null,
      block: arm.block ?? null,
      pairedExecution: arm.pairedExecution ?? null,
    });
  const stable = {
    runId: plan.runId,
    campaign: plan.campaign,
    seed: plan.seed,
    baselineSha: plan.baselineSha,
    runRoot: "<run-root>",
    sourceRoot: "<source-root>",
    harnessRoot: "<harness-root>",
    provenanceJsonlPath: plan.provenanceJsonlPath ? "<provenance-jsonl>" : null,
    provenance: plan.provenance ?? null,
    preparedButlerResource: plan.preparedButlerResource ?? null,
    pairedCampaign: plan.pairedCampaign ?? null,
    ...(plan.afterOnlyCampaign ? { afterOnlyCampaign: plan.afterOnlyCampaign } : {}),
    tracks: plan.tracks,
    fixtures: plan.fixtures,
    policy: plan.policy ?? null,
    arms: plan.arms.map(publicArm),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = xorshift32(state);
    const target = state % (index + 1);
    const current = result[index];
    result[index] = result[target]!;
    result[target] = current!;
  }
  return result;
}

export function deriveArmSeed(
  seed: number,
  scenario: BenchmarkScenario,
  track: BenchmarkTrack,
  cache: BenchmarkCacheState,
  repetition: number,
): number {
  let hash = seed >>> 0;
  const key = `${scenario}|${track}|${cache}|${repetition}`;
  for (const character of key) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619) >>> 0;
  }
  return xorshift32(hash);
}

export function summarizePlan(plan: BenchmarkPlan): {
  armCount: number;
  byScenario: Record<BenchmarkScenario, number>;
  byAgent: Record<BenchmarkAgent, number>;
} {
  const byScenario = {
    direct_conversation: 0,
    current_web_research: 0,
    butler_landing_page: 0,
    "direct-cold": 0,
    "direct-warm": 0,
    "current-web-cold": 0,
    "landing-cold": 0,
  } satisfies Record<BenchmarkScenario, number>;
  const byAgent = { butler: 0, hermes: 0, opencode: 0 } satisfies Record<BenchmarkAgent, number>;
  for (const arm of plan.arms) {
    byScenario[arm.scenario] += 1;
    byAgent[arm.agent] += 1;
  }
  return { armCount: plan.arms.length, byScenario, byAgent };
}

function assertSeed(seed: number): void {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error("seed must be an unsigned 32-bit integer");
  }
}

function xorshift32(value: number): number {
  let state = value >>> 0;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, "-");
}
