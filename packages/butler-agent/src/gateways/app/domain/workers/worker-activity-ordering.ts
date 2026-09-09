import type { WorkerActivitySummary } from "../../interface/protocol/app-protocol.ts";

const WORKER_DISPLAY_NAMES = [
  "Ari",
  "Mina",
  "Juno",
  "Theo",
  "Nora",
  "Leo",
  "Ivy",
  "Sage",
  "Kai",
  "Rina",
  "Noel",
  "Yuna",
  "Milo",
  "Luna",
  "Remi",
  "Niko",
  "Maya",
  "Rio",
  "Cora",
  "Eden",
  "Finn",
  "Hana",
  "Iris",
  "Jude",
  "Kira",
  "Luca",
  "Mira",
  "Nia",
  "Oren",
  "Pia",
  "Quinn",
  "Ravi",
  "Sora",
  "Tali",
  "Uma",
  "Vera",
  "Wynn",
  "Xena",
  "Yuri",
  "Zane",
  "Asha",
  "Bo",
  "Cleo",
  "Dara",
  "Elio",
  "Faye",
  "Gio",
  "Hope",
  "Ivo",
  "Jo",
] as const;

const LEGACY_WORKER_DISPLAY_NAME_COUNT = 12;

export function relabelWorkerActivities(
  workers: WorkerActivitySummary[],
): WorkerActivitySummary[] {
  const planTotal = workers.filter(
    (worker) => worker.activity_kind === "planned",
  ).length;
  let planIndex = 0;
  let workerIndex = 0;
  const usedDisplayNames = new Set<string>();
  return workers.map((worker) => {
    if (worker.activity_kind === "planned") {
      planIndex += 1;
      return {
        ...worker,
        worker_label: planTotal === 1 ? "Plan" : `Plan ${planIndex}`,
        worker_display_name: planTotal === 1 ? "Plan" : `Plan ${planIndex}`,
        worker_ordinal_label: planTotal === 1 ? "Plan" : `Plan ${planIndex}`,
      };
    }
    workerIndex += 1;
    const ordinalLabel = `Worker ${workerIndex}`;
    const displayName = uniqueWorkerDisplayNameFor(
      worker.worker_id,
      usedDisplayNames,
    );
    return {
      ...worker,
      worker_label: ordinalLabel,
      worker_display_name: displayName,
      worker_ordinal_label: ordinalLabel,
    };
  });
}

export function orderWorkerActivities(
  workers: WorkerActivitySummary[],
): WorkerActivitySummary[] {
  const plannedKeys = new Set(
    workers
      .filter((worker) => worker.activity_kind === "planned")
      .map((worker) => worker.task_id ?? worker.orchestration_id)
      .filter((key): key is string => Boolean(key)),
  );
  const childrenByParent = new Map<string, WorkerActivitySummary[]>();
  for (const worker of workers) {
    if (worker.activity_kind === "planned" || !worker.orchestration_id) {
      continue;
    }
    const children = childrenByParent.get(worker.orchestration_id) ?? [];
    children.push(worker);
    childrenByParent.set(worker.orchestration_id, children);
  }

  const ordered: WorkerActivitySummary[] = [];
  for (const worker of workers) {
    if (worker.activity_kind === "planned") {
      const key = worker.task_id ?? worker.orchestration_id ?? worker.worker_id;
      ordered.push(worker, ...(childrenByParent.get(key) ?? []));
      continue;
    }
    if (worker.orchestration_id && plannedKeys.has(worker.orchestration_id)) {
      continue;
    }
    ordered.push(worker);
  }
  return ordered;
}

function uniqueWorkerDisplayNameFor(
  workerId: string,
  usedNames: Set<string>,
): string {
  const seed = stableNameSeed(workerId);
  const legacyNames = WORKER_DISPLAY_NAMES.slice(
    0,
    LEGACY_WORKER_DISPLAY_NAME_COUNT,
  );
  const expandedNames = WORKER_DISPLAY_NAMES.slice(
    LEGACY_WORKER_DISPLAY_NAME_COUNT,
  );
  const baseName = firstAvailableName(legacyNames, seed, usedNames) ??
    firstAvailableName(expandedNames, seed, usedNames);
  if (baseName) return baseName;
  for (let suffix = 2; ; suffix += 1) {
    const suffixedName = firstAvailableName(
      WORKER_DISPLAY_NAMES.map((name) => `${name} ${suffix}`),
      seed,
      usedNames,
    );
    if (suffixedName) return suffixedName;
  }
}

function firstAvailableName(
  names: readonly string[],
  seed: number,
  usedNames: Set<string>,
): string | null {
  for (let offset = 0; offset < names.length; offset += 1) {
    const candidate = names[(seed + offset) % names.length] ?? null;
    if (!candidate || usedNames.has(candidate)) continue;
    usedNames.add(candidate);
    return candidate;
  }
  return null;
}

function stableNameSeed(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
