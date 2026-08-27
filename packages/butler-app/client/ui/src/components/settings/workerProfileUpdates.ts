import type {
  AppModelSummary,
  ReasoningEffort,
  WorkerProfile,
  WorkerProfileBuiltinJobName,
  WorkerProfileCustomJob,
  WorkerProfileJob,
} from "@/app/types.ts";

export const WORKER_PROFILE_BUILTIN_JOBS: WorkerProfileBuiltinJobName[] = [
  "coding",
  "research",
  "debug",
  "review",
  "writing",
];

const DEFAULT_WORKER_PROFILE_ID = "default";

export const WORKER_PROFILES_LIMIT = 12;

export const SIMULTANEOUS_WORKERS_MIN = 1;

export const SIMULTANEOUS_WORKERS_MAX = 10;

interface WorkerProfileSlot { id: string; label: string; }

function lowestFreeNumber(
  taken: ReadonlySet<string>,
  format: (n: number) => string,
): number {
  for (let n = 1; n <= WORKER_PROFILES_LIMIT; n += 1) {
    if (!taken.has(format(n).toLocaleLowerCase("en-US"))) return n;
  }
  return WORKER_PROFILES_LIMIT;
}

function nextWorkerProfileSlot(
  profiles: WorkerProfile[],
): WorkerProfileSlot | null {
  if (profiles.length >= WORKER_PROFILES_LIMIT) return null;
  const takenIds = new Set(
    profiles.map((profile) => profile.id.toLocaleLowerCase("en-US")),
  );
  const takenLabels = new Set(
    profiles.map((profile) => profile.label.trim().toLocaleLowerCase("en-US")),
  );
  return {
    id: `worker-${lowestFreeNumber(takenIds, (n) => `worker-${n}`)}`,
    label: `Worker ${lowestFreeNumber(takenLabels, (n) => `Worker ${n}`)}`,
  };
}

export function createWorkerProfileInNextSlot(
  profiles: WorkerProfile[],
  models: AppModelSummary[],
): WorkerProfile | null {
  const slot = nextWorkerProfileSlot(profiles);
  if (!slot) return null;
  const defaultProfile = profiles.find(
    (profile) => profile.id === DEFAULT_WORKER_PROFILE_ID,
  );
  const fallbackModel = models[0];
  return {
    id: slot.id,
    label: slot.label,
    enabled: true,
    job: { kind: "builtin", job: "coding" },
    model: defaultProfile?.model ?? fallbackModel?.model_ref ?? "",
    reasoning_effort:
      defaultProfile?.reasoning_effort ??
      fallbackModel?.default_reasoning_effort ??
      "medium",
  };
}

export function removeWorkerProfileById(
  profiles: WorkerProfile[],
  id: string,
): WorkerProfile[] {
  if (id === DEFAULT_WORKER_PROFILE_ID) return profiles;
  return profiles.filter((profile) => profile.id !== id);
}

export function normalizeSimultaneousWorkers(
  rawText: string,
  current: number,
): number | null {
  if (!/^\d+$/u.test(rawText.trim())) return null;
  const value = Number(rawText);
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < SIMULTANEOUS_WORKERS_MIN ||
    value > SIMULTANEOUS_WORKERS_MAX ||
    value === current
  ) {
    return null;
  }
  return value;
}

interface WorkerProfileJobSelection {
  job?: WorkerProfileJob;
  persistent: boolean;
}

interface WorkerProfileModelSelection {
  model: string;
  reasoning_effort: ReasoningEffort;
}

function isBuiltinJobName(value: string): value is WorkerProfileBuiltinJobName {
  return (WORKER_PROFILE_BUILTIN_JOBS as string[]).includes(value);
}

export function selectWorkerProfileJob(
  value: string,
): WorkerProfileJobSelection | null {
  if (isBuiltinJobName(value)) {
    return { persistent: true, job: { kind: "builtin", job: value } };
  }
  if (value === "custom") {
    return { persistent: false };
  }
  return null;
}

export const WORKER_PROFILE_CUSTOM_JOB_MAX_LENGTH = 160;

export function commitWorkerProfileCustomJob(
  rawText: string,
): WorkerProfileCustomJob | null {
  const text = rawText.trim();
  if (!text || text.length > WORKER_PROFILE_CUSTOM_JOB_MAX_LENGTH) return null;
  return { kind: "custom", text };
}

export function selectWorkerProfileModel(
  models: AppModelSummary[],
  modelRef: string,
  currentEffort: ReasoningEffort,
): WorkerProfileModelSelection {
  const nextModel = models.find((model) => model.model_ref === modelRef);
  const keepsEffort = Boolean(
    nextModel?.reasoning_efforts?.includes(currentEffort) &&
      !(
        nextModel.provider_id === "local" &&
        nextModel.local_reasoning_budget_ratio &&
        currentEffort === "none"
      ),
  );
  return {
    model: modelRef,
    reasoning_effort: keepsEffort
      ? currentEffort
      : (nextModel?.default_reasoning_effort ?? "medium"),
  };
}
