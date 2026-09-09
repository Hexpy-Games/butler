import {
  findModelMetadata,
  listModelMetadata,
  resolveRegisteredRuntimeModelMetadata,
  type ProviderModelMetadata,
} from "../../../../integrations/providers/model-catalog.ts";
import {
  DEFAULT_MAX_SIMULTANEOUS_WORKERS,
  DEFAULT_WORKER_PROFILE_ID,
  MAX_SIMULTANEOUS_WORKERS_LIMIT,
  MAX_WORKER_PROFILES,
  WORKER_PROFILE_BUILTIN_JOBS,
  WORKER_PROFILE_CUSTOM_JOB_TEXT_MAX_LENGTH,
  WORKER_PROFILE_DOMAIN_MAX_LENGTH,
  WORKER_PROFILE_ID_PATTERN,
  WORKER_PROFILE_LABEL_MAX_LENGTH,
  WORKER_PROFILE_PROMPT_MAX_LENGTH,
  type WorkerProfileJob,
} from "../../interface/protocol/app-protocol.ts";
import type {
  SettingsView,
  WorkerProfile,
} from "../../interface/protocol/app-protocol.ts";

interface WorkerProfilePrimaryModel {
  model: string;
  reasoning_effort: SettingsView["reasoning_effort"];
}

export function migrateLegacyWorkerModelRules(
  input: unknown,
  extraModels: ProviderModelMetadata[] = [],
  primary: WorkerProfilePrimaryModel,
): WorkerProfile[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const entries = input
    .filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
    )
    .slice(0, MAX_WORKER_PROFILES);
  if (entries.length === 0) return undefined;
  const knownModels = allKnownModels(extraModels);
  const seenIds = new Set<string>([DEFAULT_WORKER_PROFILE_ID]);
  const profiles = entries.map((entry, index) => {
    const isDefault = index === 0;
    return legacyProfileFromEntry(entry, knownModels, extraModels, primary, {
      index,
      isDefault,
      id: isDefault
        ? DEFAULT_WORKER_PROFILE_ID
        : nextWorkerProfileId(seenIds),
      labelFallback: isDefault ? "Default" : `Worker ${index + 1}`,
    });
  });
  return ensureDefaultWorkerProfile(profiles, primary);
}

export function normalizeStoredWorkerProfiles(
  input: unknown,
  extraModels: ProviderModelMetadata[] = [],
  primary: WorkerProfilePrimaryModel,
): WorkerProfile[] {
  const knownModels = allKnownModels(extraModels);
  const raw = Array.isArray(input) ? input : [];
  const reservedIds = new Set<string>([DEFAULT_WORKER_PROFILE_ID]);
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const id = Reflect.get(entry, "id");
    if (typeof id === "string" && /^w[1-9]\d*$/u.test(id.trim())) {
      reservedIds.add(id.trim());
    }
  }
  const seenIds = new Set<string>();
  const profiles = raw
    .filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
    )
    .slice(0, MAX_WORKER_PROFILES)
    .map((entry) => {
      const requestedId = typeof entry.id === "string" ? entry.id.trim() : "";
      const id = WORKER_PROFILE_ID_PATTERN.test(requestedId) &&
          !seenIds.has(requestedId)
        ? requestedId
        : nextWorkerProfileId(new Set([...reservedIds, ...seenIds]));
      seenIds.add(id);
      return storedProfileFromEntry(entry, knownModels, extraModels, primary, {
        id,
      });
    });
  return ensureDefaultWorkerProfile(profiles, primary);
}

export function defaultWorkerProfileFor(
  primary: WorkerProfilePrimaryModel,
): WorkerProfile {
  return {
    id: DEFAULT_WORKER_PROFILE_ID,
    label: "Default",
    enabled: true,
    job: { kind: "builtin", job: WORKER_PROFILE_BUILTIN_JOBS[0] },
    model: primary.model,
    reasoning_effort: primary.reasoning_effort,
  };
}

export function normalizeMaxSimultaneousWorkers(input: unknown): number {
  if (
    typeof input === "number" &&
    Number.isInteger(input) &&
    input >= 1 &&
    input <= MAX_SIMULTANEOUS_WORKERS_LIMIT
  ) {
    return input;
  }
  return DEFAULT_MAX_SIMULTANEOUS_WORKERS;
}

function ensureDefaultWorkerProfile(
  profiles: WorkerProfile[],
  primary: WorkerProfilePrimaryModel,
): WorkerProfile[] {
  const bounded = profiles.slice(0, MAX_WORKER_PROFILES);
  const existingIndex = bounded.findIndex(
    (profile) => profile.id === DEFAULT_WORKER_PROFILE_ID,
  );
  const restored =
    existingIndex >= 0
      ? { ...bounded[existingIndex]!, enabled: true }
      : defaultWorkerProfileFor(primary);
  const others = bounded.filter((_, index) => index !== existingIndex);
  return [restored, ...others.slice(0, MAX_WORKER_PROFILES - 1)];
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

function isBoundedText(value: string, maxLength: number): boolean {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length > 0 && text.length <= maxLength;
}

interface WorkerModelRuleShape {
  id?: unknown;
  label?: unknown;
  condition?: unknown;
  model?: unknown;
  reasoning_effort?: unknown;
  enabled?: unknown;
}

function legacyProfileFromEntry(
  entry: WorkerModelRuleShape,
  knownModels: ProviderModelMetadata[],
  extraModels: ProviderModelMetadata[],
  primary: WorkerProfilePrimaryModel,
  options: {
    index: number;
    isDefault: boolean;
    id: string;
    labelFallback: string;
  },
): WorkerProfile {
  const condition =
    typeof entry.condition === "string"
      ? entry.condition.replace(/\s+/gu, " ").trim()
      : "";
  const job: WorkerProfileJob = condition
    ? {
        kind: "custom",
        text: condition.slice(0, WORKER_PROFILE_CUSTOM_JOB_TEXT_MAX_LENGTH),
      }
    : { kind: "builtin", job: WORKER_PROFILE_BUILTIN_JOBS[0] };
  return {
    id: options.id,
    label: safeProfileText(entry.label, options.labelFallback, WORKER_PROFILE_LABEL_MAX_LENGTH),
    enabled: options.isDefault ? true : entry.enabled !== false,
    job,
    ...repairedModelFields(entry, knownModels, extraModels, primary),
  };
}

function storedProfileFromEntry(
  entry: Record<string, unknown>,
  knownModels: ProviderModelMetadata[],
  extraModels: ProviderModelMetadata[],
  primary: WorkerProfilePrimaryModel,
  options: { id: string },
): WorkerProfile {
  const candidate = entry as Partial<WorkerProfile>;
  return {
    id: options.id,
    label: safeProfileText(
      candidate.label,
      "Worker profile",
      WORKER_PROFILE_LABEL_MAX_LENGTH,
    ),
    enabled: candidate.enabled !== false,
    job: isValidWorkerProfileJob(candidate.job)
      ? candidate.job
      : { kind: "builtin", job: WORKER_PROFILE_BUILTIN_JOBS[0] },
    ...(typeof candidate.domain === "string" &&
    isBoundedText(candidate.domain, WORKER_PROFILE_DOMAIN_MAX_LENGTH)
      ? { domain: candidate.domain }
      : {}),
    ...repairedModelFields(candidate, knownModels, extraModels, primary),
    ...(typeof candidate.prompt === "string" &&
    candidate.prompt.length <= WORKER_PROFILE_PROMPT_MAX_LENGTH
      ? { prompt: candidate.prompt }
      : {}),
  };
}

function repairedModelFields(
  entry: {
    model?: unknown;
    reasoning_effort?: unknown;
  },
  knownModels: ProviderModelMetadata[],
  extraModels: ProviderModelMetadata[],
  primary: WorkerProfilePrimaryModel,
): Pick<WorkerProfile, "model" | "reasoning_effort"> {
  const candidateModel = typeof entry.model === "string" ? entry.model.trim() : "";
  const match = candidateModel
    ? findModelMetadata(candidateModel, knownModels)
    : undefined;
  const selectable =
    match &&
    match.runtime_supported &&
    match.registered !== false &&
    match.enabled !== false
      ? match
      : undefined;
  if (!selectable) {
    return { model: primary.model, reasoning_effort: primary.reasoning_effort };
  }
  const requestedEffort = supportedReasoningEffort(
    entry.reasoning_effort,
    selectable.reasoning_efforts,
  );
  const effort =
    requestedEffort ??
    (selectable.reasoning_efforts.includes(primary.reasoning_effort)
      ? primary.reasoning_effort
      : resolveRegisteredRuntimeModelMetadata(
          selectable.model_ref,
          extraModels,
        ).default_reasoning_effort);
  return { model: selectable.model_ref, reasoning_effort: effort };
}

function supportedReasoningEffort(
  value: unknown,
  efforts: readonly string[],
): SettingsView["reasoning_effort"] | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value as SettingsView["reasoning_effort"];
  return efforts.includes(candidate) ? candidate : undefined;
}

function nextWorkerProfileId(taken: Set<string>): string {
  for (let number = 1; ; number += 1) {
    const candidate = `w${number}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

function safeProfileText(
  input: unknown,
  fallback: string,
  maxLength: number,
): string {
  const value = typeof input === "string" ? input.replace(/\s+/gu, " ").trim() : "";
  if (!value) return fallback;
  return value.length > maxLength
    ? value.slice(0, maxLength - 1).trimEnd()
    : value;
}

function allKnownModels(
  registeredModels: ProviderModelMetadata[],
): ProviderModelMetadata[] {
  const byRef = new Map<string, ProviderModelMetadata>();
  for (const model of listModelMetadata(registeredModels)) {
    byRef.set(model.model_ref, model);
  }
  return [...byRef.values()];
}
