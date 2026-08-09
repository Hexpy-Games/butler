import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  AGENT_BENCHMARK_BASELINE_SHA,
  AGENT_BENCHMARK_SCHEMA,
  type BenchmarkAgent,
  type BenchmarkArmPlan,
  type BenchmarkCacheState,
  type BenchmarkPlan,
  type BenchmarkScenario,
  type BenchmarkTrack,
  type EffectiveAgentConfig,
} from "./contracts.ts";
import {
  AGENT_BENCHMARK_FIXTURES,
  hashBenchmarkFixture,
  summarizeBenchmarkFixture,
} from "./fixtures.ts";
import { sanitizeIdentifier } from "./identifiers.ts";

export const BENCHMARK_AGENTS: readonly BenchmarkAgent[] = [
  "butler",
  "hermes",
  "opencode",
];
export const BENCHMARK_TRACKS: readonly BenchmarkTrack[] = [
  "controlled",
  "recommended-default",
];
export const BENCHMARK_CACHE_STATES: readonly BenchmarkCacheState[] = [
  "cold",
  "warm",
];
export const DEFAULT_BENCHMARK_TIMEOUT_MS = 15 * 60 * 1_000;

export interface CreateBenchmarkPlanInput {
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
  const baselineSha = input.baselineSha ?? AGENT_BENCHMARK_BASELINE_SHA;
  if (baselineSha !== AGENT_BENCHMARK_BASELINE_SHA) {
    throw new Error(
      `Benchmark baseline must be origin/main ${AGENT_BENCHMARK_BASELINE_SHA}; received ${baselineSha}`,
    );
  }
  const repetitionsPerCache = input.repetitionsPerCache ?? 1;
  if (!Number.isSafeInteger(repetitionsPerCache) || repetitionsPerCache < 1) {
    throw new Error("repetitionsPerCache must be a positive integer");
  }
  const runRoot = resolve(input.runRoot);
  const sourceRoot = resolve(input.sourceRoot);
  const fixtures = AGENT_BENCHMARK_FIXTURES.map(summarizeBenchmarkFixture);
  const arms: BenchmarkArmPlan[] = [];
  let order = 0;
  for (const fixture of AGENT_BENCHMARK_FIXTURES) {
    for (const track of BENCHMARK_TRACKS) {
      for (let repetition = 1; repetition <= repetitionsPerCache; repetition += 1) {
        const randomizedAgents = seededShuffle(
          BENCHMARK_AGENTS,
          deriveArmSeed(input.seed, fixture.id, track, "cold", repetition),
        );
        for (const agent of randomizedAgents) {
          for (const cache of BENCHMARK_CACHE_STATES) {
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
              effectiveConfig: effectiveConfig(agent, track, input),
              sourceRoot,
              outputRoot: join(armRoot, "output"),
              dataRoot: join(armRoot, "data"),
              evidenceRoot: join(armRoot, "evidence"),
              cacheRoot,
              cachePairId,
              timeoutMs: DEFAULT_BENCHMARK_TIMEOUT_MS,
            });
            order += 1;
          }
        }
      }
    }
  }
  return {
    schema: AGENT_BENCHMARK_SCHEMA,
    kind: "agent_benchmark_plan",
    runId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    seed: input.seed,
    baselineSha,
    runRoot,
    sourceRoot,
    tracks: BENCHMARK_TRACKS,
    fixtures,
    arms,
  };
}

/** Stable identity for checkpoint resume; excludes only volatile createdAt. */
export function benchmarkPlanIdentity(
  plan: Pick<BenchmarkPlan, "runId" | "seed" | "baselineSha" | "runRoot" | "sourceRoot" | "tracks" | "fixtures" | "arms">,
): string {
  const stable = {
    runId: plan.runId,
    seed: plan.seed,
    baselineSha: plan.baselineSha,
    runRoot: plan.runRoot,
    sourceRoot: plan.sourceRoot,
    tracks: plan.tracks,
    fixtures: plan.fixtures,
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
  } satisfies Record<BenchmarkScenario, number>;
  const byAgent = { butler: 0, hermes: 0, opencode: 0 } satisfies Record<BenchmarkAgent, number>;
  for (const arm of plan.arms) {
    byScenario[arm.scenario] += 1;
    byAgent[arm.agent] += 1;
  }
  return { armCount: plan.arms.length, byScenario, byAgent };
}

function effectiveConfig(
  agent: BenchmarkAgent,
  track: BenchmarkTrack,
  input: CreateBenchmarkPlanInput,
): EffectiveAgentConfig {
  if (track === "controlled") {
    const model = sanitizeIdentifier(input.controlledModel);
    if (!model) throw new Error("controlledModel must be a safe non-empty model identifier");
    const reasoning = sanitizeIdentifier(input.controlledReasoning ?? "medium");
    if (!reasoning) throw new Error("controlledReasoning must be a safe identifier");
    if (agent === "butler") {
      // The Electron harness accepts a full-access product configuration and
      // applies the requested model/reasoning. It does not expose a supported
      // tool/memory introspection surface, so keep those dimensions honest.
      return {
        model,
        reasoning,
        permissions: "benchmark-workspace-full-source-read-only",
        tools: ["product-default"],
        memoryEnabled: null,
        skillsEnabled: null,
        pluginsEnabled: null,
        mcpEnabled: null,
        provider: null,
        variant: null,
      };
    }
    // Hermes exposes no official per-run reasoning-effort option. The adapter
    // records that dimension as unavailable instead of claiming the operator's
    // requested value was applied.
    const effectiveReasoning = agent === "hermes" ? null : reasoning;
    return {
      model,
      reasoning: effectiveReasoning,
      permissions: "benchmark-workspace-full-source-read-only",
      tools: ["filesystem", "web"],
      memoryEnabled: false,
      skillsEnabled: false,
      pluginsEnabled: false,
      mcpEnabled: false,
      provider: null,
      variant: agent === "hermes" ? null : effectiveReasoning,
    };
  }
  return {
    model: null,
    reasoning: null,
    permissions: "product-recommended-default",
    tools: agent === "butler" ? ["product-default"] : ["filesystem", "web", "terminal"],
    memoryEnabled: null,
    skillsEnabled: null,
    pluginsEnabled: null,
    mcpEnabled: null,
    provider: null,
    variant: null,
  };
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
