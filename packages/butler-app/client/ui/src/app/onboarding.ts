import type { OnboardingSettingsView } from "./types.ts";

/**
 * Onboarding state lives in the agent (`settings.onboarding`, #230). The app
 * owns the consent text, so it owns its version: bump this when the welcome
 * consent lines change and agents with an older version show only the
 * consent step again.
 */
export const FIRST_RUN_CONSENT_VERSION = 1;

/** Pre-#230 renderer flag; read once to migrate existing installs. */
export const LEGACY_FIRST_RUN_STORAGE_KEY = "butler:first-run-setup:v1";

/** `first-run`: welcome and pick an AI. `consent`: welcome only. `workspace`: no setup. */
export type OnboardingGate = "first-run" | "consent" | "workspace";

type OnboardingPatch = { onboarding: OnboardingSettingsView };

/** The legacy renderer record of a finished first run (agents without `settings.onboarding`, smokes). */
export function legacyFirstRunCompleteRecord(completedAt = new Date().toISOString()) {
  return { schema: "butler.app.first-run.v1", status: "complete", completed_at: completedAt } as const;
}

/** `completed_at` of a completed legacy first run in renderer storage, else null. */
export function readLegacyFirstRunCompletedAt(storage: Pick<Storage, "getItem">): string | null {
  try {
    const raw = storage.getItem(LEGACY_FIRST_RUN_STORAGE_KEY);
    const record = raw ? JSON.parse(raw) as Record<string, unknown> : null;
    if (record?.schema !== "butler.app.first-run.v1" || record.status !== "complete") return null;
    return typeof record.completed_at === "string" && record.completed_at ? record.completed_at : null;
  } catch {
    return null;
  }
}

export function consentIsCurrent(
  onboarding: OnboardingSettingsView | null | undefined,
  consentVersion = FIRST_RUN_CONSENT_VERSION,
): boolean {
  const accepted = Number(onboarding?.consent_version ?? 0);
  return Number.isFinite(accepted) && accepted >= consentVersion;
}

/**
 * Which setup to show (or none). Before the agent answers, a legacy completion
 * flag keeps existing installs in the workspace; after it answers, the agent
 * is the source of truth (a legacy flag still counts until it is migrated).
 */
export function resolveOnboardingGate({
  onboarding,
  agentLoaded,
  legacyCompletedAt,
  consentVersion = FIRST_RUN_CONSENT_VERSION,
}: {
  onboarding: OnboardingSettingsView | null | undefined;
  agentLoaded: boolean;
  legacyCompletedAt: string | null;
  consentVersion?: number;
}): OnboardingGate {
  if (!agentLoaded) return legacyCompletedAt ? "workspace" : "first-run";
  if (!onboarding?.completed_at && !legacyCompletedAt) return "first-run";
  return consentIsCurrent(onboarding, consentVersion) ? "workspace" : "consent";
}

/** The one-time PATCH that moves a legacy completion into the agent, or null. */
export function legacyMigrationPatch(
  onboarding: OnboardingSettingsView | null | undefined,
  legacyCompletedAt: string | null,
): OnboardingPatch | null {
  if (onboarding?.completed_at || !legacyCompletedAt) return null;
  return { onboarding: { ...onboarding, completed_at: legacyCompletedAt } };
}

export function consentAcceptedPatch(
  onboarding: OnboardingSettingsView | null | undefined,
  acceptedAt: string,
  consentVersion = FIRST_RUN_CONSENT_VERSION,
): OnboardingPatch {
  return { onboarding: { ...onboarding, consent_version: consentVersion, accepted_at: acceptedAt } };
}

export function onboardingCompletedPatch(
  onboarding: OnboardingSettingsView | null | undefined,
  acceptedAt: string,
  completedAt: string,
  consentVersion = FIRST_RUN_CONSENT_VERSION,
): OnboardingPatch {
  return {
    onboarding: { ...onboarding, consent_version: consentVersion, accepted_at: acceptedAt, completed_at: completedAt },
  };
}
