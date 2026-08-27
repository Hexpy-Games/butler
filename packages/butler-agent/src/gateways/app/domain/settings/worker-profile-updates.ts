import { resolveRegisteredRuntimeModelMetadata, type ProviderModelMetadata } from "../../../../integrations/providers/model-catalog.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import {
  DEFAULT_WORKER_PROFILE_ID,
  MAX_WORKER_PROFILES,
  WORKER_PROFILE_BUILTIN_JOBS,
  WORKER_PROFILE_CUSTOM_JOB_TEXT_MAX_LENGTH,
  WORKER_PROFILE_DOMAIN_MAX_LENGTH,
  WORKER_PROFILE_ID_PATTERN,
  WORKER_PROFILE_LABEL_MAX_LENGTH,
  WORKER_PROFILE_MODEL_REF_MAX_LENGTH,
  WORKER_PROFILE_PROMPT_MAX_LENGTH,
  type WorkerProfileJob,
} from "../../interface/protocol/app-protocol.ts";
import type {
  SettingsView,
  WorkerProfile,
} from "../../interface/protocol/app-protocol.ts";
import { normalizeKnownModelRef } from "./settings-models.ts";

export function normalizeWorkerProfilesUpdate(
  input: WorkerProfile[],
  extraModels: ProviderModelMetadata[] = [],
  currentWorkerProfiles: WorkerProfile[] = [],
): WorkerProfile[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw invalidWorkerProfileSettings(
      "Settings update must include at least one worker profile.",
    );
  }
  if (input.length > MAX_WORKER_PROFILES) {
    throw invalidWorkerProfileSettings(
      `Settings update exceeds the maximum of ${MAX_WORKER_PROFILES} worker profiles.`,
    );
  }
  let submittedDefault: WorkerProfile | undefined;
  const seenIds = new Set<string>();
  for (const profile of input) {
    assertPublicWorkerProfileShape(profile);
    const collisionKey = profile.id.toLocaleLowerCase("en-US");
    if (seenIds.has(collisionKey)) {
      throw invalidWorkerProfileSettings(
        "Settings update contains duplicate worker profile ids.",
      );
    }
    seenIds.add(collisionKey);
    if (profile.id === DEFAULT_WORKER_PROFILE_ID) {
      if (submittedDefault) {
        throw invalidWorkerProfileSettings(
          "Settings update contains more than one default worker profile.",
        );
      }
      if (profile.enabled !== true) {
        throw invalidWorkerProfileSettings(
          "The default worker profile cannot be disabled.",
        );
      }
      submittedDefault = profile;
    }
  }
  let defaultProfile: WorkerProfile;
  if (submittedDefault) {
    defaultProfile = withValidatedPublicModelFields(
      submittedDefault,
      extraModels,
    );
  } else {
    if (seenIds.has(DEFAULT_WORKER_PROFILE_ID)) {
      throw invalidWorkerProfileSettings(
        "Settings update contains a worker profile id that collides with the default worker profile.",
      );
    }
    const currentDefault = currentWorkerProfiles.find(
      (profile) => profile.id === DEFAULT_WORKER_PROFILE_ID,
    );
    if (!currentDefault) {
      throw invalidWorkerProfileSettings(
        "Settings update must include the default worker profile.",
      );
    }
    defaultProfile = { ...currentDefault };
  }
  const others = input
    .filter((profile) => profile.id !== DEFAULT_WORKER_PROFILE_ID)
    .map((profile) => canonicalPublicWorkerProfile(withValidatedPublicModelFields(profile, extraModels)));
  if (others.length + 1 > MAX_WORKER_PROFILES) {
    throw invalidWorkerProfileSettings(
      `Settings update exceeds the maximum of ${MAX_WORKER_PROFILES} worker profiles.`,
    );
  }
  return [canonicalPublicWorkerProfile(defaultProfile), ...others];
}

function invalidWorkerProfileSettings(message: string): AppStoreOperationError {
  return new AppStoreOperationError(400, "invalid_settings_request", message);
}

const REASONING_EFFORT_VALUES = new Set([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const WORKER_PROFILE_KEYS = new Set([
  "id",
  "label",
  "enabled",
  "job",
  "domain",
  "model",
  "reasoning_effort",
  "prompt",
]);

function assertPublicWorkerProfileShape(profile: WorkerProfile): void {
  const input = profile as unknown as Record<string, unknown>;
  if (
    !profile ||
    typeof profile !== "object" ||
    Array.isArray(profile) ||
    !Object.keys(input).every((key) => WORKER_PROFILE_KEYS.has(key))
  ) {
    throw invalidWorkerProfileSettings(
      "Settings update contains a worker profile with unsupported fields.",
    );
  }
  if (
    typeof profile.id !== "string" ||
    !WORKER_PROFILE_ID_PATTERN.test(profile.id)
  ) {
    throw invalidWorkerProfileSettings(
      "Settings update contains a worker profile with a malformed id.",
    );
  }
  if (
    typeof profile.label !== "string" ||
    !isBoundedText(profile.label, WORKER_PROFILE_LABEL_MAX_LENGTH)
  ) {
    throw invalidWorkerProfileSettings(
      "Settings update contains a worker profile with a malformed label.",
    );
  }
  if (typeof profile.enabled !== "boolean") {
    throw invalidWorkerProfileSettings(
      "Settings update contains a worker profile without a valid enabled flag.",
    );
  }
  if (!isValidWorkerProfileJob(profile.job)) {
    throw invalidWorkerProfileSettings(
      "Settings update contains a worker profile with a malformed job.",
    );
  }
  if (
    "domain" in input &&
    (typeof profile.domain !== "string" ||
      !isBoundedText(profile.domain, WORKER_PROFILE_DOMAIN_MAX_LENGTH))
  ) {
    throw invalidWorkerProfileSettings(
      "Settings update contains a worker profile with a malformed domain.",
    );
  }
  if (
    typeof profile.model !== "string" ||
    !profile.model.trim() ||
    profile.model.trim().length > WORKER_PROFILE_MODEL_REF_MAX_LENGTH ||
    /\s/u.test(profile.model.trim())
  ) {
    throw invalidWorkerProfileSettings(
      "Settings update contains a worker profile without a valid model.",
    );
  }
  if (
    typeof profile.reasoning_effort !== "string" ||
    !REASONING_EFFORT_VALUES.has(profile.reasoning_effort)
  ) {
    throw invalidWorkerProfileSettings(
      "Settings update contains a worker profile without a valid reasoning effort.",
    );
  }
  if (
    "prompt" in input &&
    (typeof profile.prompt !== "string" ||
      profile.prompt.length > WORKER_PROFILE_PROMPT_MAX_LENGTH)
  ) {
    throw invalidWorkerProfileSettings(
      "Settings update contains a worker profile with a malformed prompt.",
    );
  }
}

function isValidWorkerProfileJob(value: unknown): value is WorkerProfileJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const job = value as Record<string, unknown>;
  if (job.kind === "builtin") {
    return (
      Object.keys(job).length === 2 &&
      "job" in job &&
      (WORKER_PROFILE_BUILTIN_JOBS as readonly unknown[]).includes(job.job)
    );
  }
  if (job.kind === "custom") {
    return (
      Object.keys(job).length === 2 &&
      typeof job.text === "string" &&
      isBoundedText(job.text, WORKER_PROFILE_CUSTOM_JOB_TEXT_MAX_LENGTH)
    );
  }
  return false;
}

function canonicalPublicWorkerProfile(profile: WorkerProfile): WorkerProfile {
  const canonical: WorkerProfile = {
    id: profile.id,
    label: profile.label,
    enabled: profile.enabled,
    job:
      profile.job.kind === "builtin"
        ? { kind: "builtin", job: profile.job.job }
        : { kind: "custom", text: profile.job.text },
    model: profile.model,
    reasoning_effort: profile.reasoning_effort,
  };
  const domain = typeof profile.domain === "string" ? profile.domain : undefined;
  if (domain && isBoundedText(domain, WORKER_PROFILE_DOMAIN_MAX_LENGTH)) {
    canonical.domain = domain;
  }
  if (
    typeof profile.prompt === "string" &&
    profile.prompt.length <= WORKER_PROFILE_PROMPT_MAX_LENGTH
  ) {
    canonical.prompt = profile.prompt;
  }
  return canonical;
}

function withValidatedPublicModelFields(
  profile: WorkerProfile,
  extraModels: ProviderModelMetadata[],
): WorkerProfile {
  const model = normalizeKnownModelRef(profile.model, extraModels);
  if (!model) {
    throw invalidWorkerProfileSettings(
      `Settings update contains an unsupported worker profile model for "${profile.id}".`,
    );
  }
  const metadata = resolveRegisteredRuntimeModelMetadata(model, extraModels);
  const reasoningEffort = supportedReasoningEffort(
    profile.reasoning_effort,
    metadata.reasoning_efforts,
  );
  if (!reasoningEffort) {
    throw invalidWorkerProfileSettings(
      `Settings update contains an unsupported reasoning effort for worker profile "${profile.id}".`,
    );
  }
  return {
    ...profile,
    model: metadata.model_ref,
    reasoning_effort: reasoningEffort,
  };
}

function isBoundedText(value: string, maxLength: number): boolean {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length > 0 && text.length <= maxLength;
}

function supportedReasoningEffort(
  value: unknown,
  efforts: readonly string[],
): SettingsView["reasoning_effort"] | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value as SettingsView["reasoning_effort"];
  return efforts.includes(candidate) ? candidate : undefined;
}
