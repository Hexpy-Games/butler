import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
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

export const BENCHMARK_AGENTS: readonly BenchmarkAgent[] = [
  "butler",
  "hermes",
  "opencode",
];
/**
 * Tracks that are materialized by the compact pilot.  The recommended-default
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
  baselineSha?: string;
  controlledModel: string;
  controlledReasoning?: string;
  repetitionsPerCache?: number;
  createdAt?: string;
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
  const repetitionsPerCache = input.repetitionsPerCache ?? (campaign === "m1-v2" ? 3 : 1);
  if (campaign === "cross-agent-pilot" && repetitionsPerCache !== 1) {
    throw new Error("The canonical pilot uses exactly one repetition per scenario");
  }
  const runRoot = resolve(input.runRoot);
  const sourceRoot = resolve(input.sourceRoot);
  if (campaign === "m1-v2" && (repetitionsPerCache < 3 || repetitionsPerCache > 10)) {
    throw new Error("M1 v2 repetitions must be an integer between 3 and 10");
  }
  const campaignFixtures = campaign === "m1-v2"
    ? loadM1V2BenchmarkFixtures(sourceRoot)
    : AGENT_BENCHMARK_FIXTURES;
  const fixtures = campaignFixtures.map(summarizeBenchmarkFixture);
  const arms: BenchmarkArmPlan[] = [];
  let order = 0;
  const track: BenchmarkTrack = "controlled";
  for (const fixture of campaignFixtures) {
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
  return {
    schema: AGENT_BENCHMARK_SCHEMA,
    kind: "agent_benchmark_plan",
    campaign,
    runId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    seed: input.seed,
    baselineSha,
    runRoot,
    sourceRoot,
    tracks: BENCHMARK_TRACKS,
    fixtures,
    ...(campaign === "m1-v2" ? { policy: {
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
}

/** Stable identity for checkpoint resume; excludes only volatile createdAt. */
export function benchmarkPlanIdentity(
  plan: Pick<BenchmarkPlan, "campaign" | "runId" | "seed" | "baselineSha" | "runRoot" | "sourceRoot" | "tracks" | "fixtures" | "arms" | "policy">,
): string {
  const stable = {
    runId: plan.runId,
    campaign: plan.campaign,
    seed: plan.seed,
    baselineSha: plan.baselineSha,
    runRoot: plan.runRoot,
    sourceRoot: plan.sourceRoot,
    tracks: plan.tracks,
    fixtures: plan.fixtures,
    policy: plan.policy ?? null,
    arms: plan.arms.map((arm) => ({
      key: arm.key,
      scenario: arm.scenario,
      repetition: arm.repetition,
      order: arm.order,
      agent: arm.agent,
      track: arm.track,
      cache: arm.cache,
      fixtureHash: arm.fixtureHash,
      effectiveConfig: arm.effectiveConfig,
      sourceRoot: arm.sourceRoot,
      outputRoot: arm.outputRoot,
      dataRoot: arm.dataRoot,
      evidenceRoot: arm.evidenceRoot,
      cacheRoot: arm.cacheRoot,
      cachePairId: arm.cachePairId,
      timeoutMs: arm.timeoutMs,
      sourceRevision: arm.sourceRevision,
    })),
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
