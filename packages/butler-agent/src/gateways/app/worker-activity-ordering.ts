import type { WorkerActivitySummary } from "./protocol.ts";

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
] as const;

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
  for (let cycle = 0; ; cycle += 1) {
    for (let offset = 0; offset < WORKER_DISPLAY_NAMES.length; offset += 1) {
      const baseName =
        WORKER_DISPLAY_NAMES[(seed + offset) % WORKER_DISPLAY_NAMES.length] ??
          "Ari";
      const candidate = cycle === 0 ? baseName : `${baseName} ${cycle + 1}`;
      if (usedNames.has(candidate)) continue;
      usedNames.add(candidate);
      return candidate;
    }
  }
}

function stableNameSeed(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
