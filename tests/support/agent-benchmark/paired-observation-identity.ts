import type { BenchmarkArmPlan } from "./contracts.ts";

export function pairedObservationIdentityMatches(expected: BenchmarkArmPlan, observed: BenchmarkArmPlan): boolean {
  return JSON.stringify(publicIdentity(expected)) === JSON.stringify(publicIdentity(observed));
}

function publicIdentity(arm: BenchmarkArmPlan) {
  return {
    key: arm.key,
    scenario: arm.scenario,
    repetition: arm.repetition,
    order: arm.order,
    agent: arm.agent,
    track: arm.track,
    cache: arm.cache,
    fixtureHash: arm.fixtureHash,
    effectiveConfig: arm.effectiveConfig,
    cachePairId: arm.cachePairId,
    timeoutMs: arm.timeoutMs,
    sourceRevision: arm.sourceRevision,
    version: arm.version,
    pairId: arm.pairId,
    block: arm.block,
    pairedExecution: arm.pairedExecution,
  };
}
