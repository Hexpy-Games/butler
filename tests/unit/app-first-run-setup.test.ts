import { expect, test } from "bun:test";
import { detectFirstRunLanguage } from "../../packages/butler-app/client/ui/src/app/firstRunSetup.ts";
import {
  FIRST_RUN_CONSENT_VERSION,
  LEGACY_FIRST_RUN_STORAGE_KEY,
  consentAcceptedPatch,
  consentIsCurrent,
  legacyMigrationPatch,
  onboardingCompletedPatch,
  readLegacyFirstRunCompletedAt,
  resolveOnboardingGate,
} from "../../packages/butler-app/client/ui/src/app/onboarding.ts";

class MemoryStorage implements Pick<Storage, "getItem"> {
  constructor(private readonly values: Record<string, string> = {}) {}

  getItem(key: string): string | null {
    return this.values[key] ?? null;
  }
}

const legacyComplete = JSON.stringify({
  schema: "butler.app.first-run.v1",
  status: "complete",
  language: "ko",
  step: "model",
  completed_at: "2026-06-01T00:00:00.000Z",
});

test("first-run language detection preselects Korean from system languages", () => {
  expect(detectFirstRunLanguage(["ko-KR", "en-US"])).toBe("ko");
  expect(detectFirstRunLanguage(["en-US"])).toBe("en");
  expect(detectFirstRunLanguage([])).toBe("en");
});

test("the legacy renderer flag counts only for a completed first run", () => {
  expect(readLegacyFirstRunCompletedAt(new MemoryStorage({ [LEGACY_FIRST_RUN_STORAGE_KEY]: legacyComplete })))
    .toBe("2026-06-01T00:00:00.000Z");
  const pending = JSON.stringify({ schema: "butler.app.first-run.v1", status: "pending", step: "safety" });
  expect(readLegacyFirstRunCompletedAt(new MemoryStorage({ [LEGACY_FIRST_RUN_STORAGE_KEY]: pending }))).toBeNull();
  expect(readLegacyFirstRunCompletedAt(new MemoryStorage({ [LEGACY_FIRST_RUN_STORAGE_KEY]: "{not json" }))).toBeNull();
  expect(readLegacyFirstRunCompletedAt(new MemoryStorage())).toBeNull();
});

// test-category: pure-logic
test("before the agent answers, every install stays in the neutral boot state", () => {
  expect(resolveOnboardingGate({ onboarding: null, agentLoaded: false, legacyCompletedAt: null })).toBe("pending");
  expect(resolveOnboardingGate({ onboarding: null, agentLoaded: false, legacyCompletedAt: "2026-06-01" })).toBe("pending");
});

test("the agent's completed_at skips first run; an older consent version re-shows only the consent step", () => {
  const current = { consent_version: FIRST_RUN_CONSENT_VERSION, accepted_at: "a", completed_at: "c" };
  expect(resolveOnboardingGate({ onboarding: current, agentLoaded: true, legacyCompletedAt: null })).toBe("workspace");
  expect(resolveOnboardingGate({ onboarding: { completed_at: "c" }, agentLoaded: true, legacyCompletedAt: null })).toBe("consent");
  expect(resolveOnboardingGate({ onboarding: current, agentLoaded: true, legacyCompletedAt: null, consentVersion: FIRST_RUN_CONSENT_VERSION + 1 }))
    .toBe("consent");
  expect(resolveOnboardingGate({ onboarding: {}, agentLoaded: true, legacyCompletedAt: null })).toBe("first-run");
  expect(resolveOnboardingGate({ onboarding: undefined, agentLoaded: true, legacyCompletedAt: null })).toBe("first-run");
  // A finished first run on an agent that already recorded consent is not asked again.
  expect(consentIsCurrent(current)).toBe(true);
  expect(consentIsCurrent({ consent_version: null })).toBe(false);
});

test("an upgrade migrates the legacy completion once, then the agent decides", () => {
  expect(resolveOnboardingGate({ onboarding: {}, agentLoaded: true, legacyCompletedAt: "2026-06-01" })).toBe("consent");
  expect(legacyMigrationPatch({ consent_version: null }, "2026-06-01")).toEqual({
    onboarding: { consent_version: null, completed_at: "2026-06-01" },
  });
  expect(legacyMigrationPatch({ completed_at: "2026-07-01" }, "2026-06-01")).toBeNull();
  expect(legacyMigrationPatch({}, null)).toBeNull();
});

test("consent and completion patches carry the current consent version", () => {
  expect(consentAcceptedPatch({ completed_at: "c" }, "now")).toEqual({
    onboarding: { completed_at: "c", consent_version: FIRST_RUN_CONSENT_VERSION, accepted_at: "now" },
  });
  expect(onboardingCompletedPatch(undefined, "accepted", "done")).toEqual({
    onboarding: { consent_version: FIRST_RUN_CONSENT_VERSION, accepted_at: "accepted", completed_at: "done" },
  });
});
