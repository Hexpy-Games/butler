import { loadProjectLedgerCore } from "./project-ledger-core.ts";

export type ProjectLedgerRecordUpdate = {
  operation?: "create" | "update";
  id: string;
  kind?: string;
  parentId?: string;
  title?: string;
  status?: string;
  body?: string;
  spec?: string;
  acceptance?: string;
  validation?: string;
  review?: string;
  report?: string;
  implementation?: string;
  mitigation?: string;
  reason?: string;
  codeCommits?: string;
  ledgerCommits?: string;
  priority?: number;
  requiresCommitEvidence?: boolean;
};

export function applyProjectLedgerRecordUpdate(
  core: Awaited<ReturnType<typeof loadProjectLedgerCore>>,
  projectRoot: string,
  update: ProjectLedgerRecordUpdate,
): void {
  if (update.operation === "create") {
    createRecord(core, projectRoot, update);
    return;
  }
  const current = core.resolveRecord(projectRoot, {
    id: update.id,
    ...(update.kind ? { kind: update.kind } : {}),
  }).record;
  if (!update.status || !["work", "task", "attempt"].includes(current.kind)) {
    core.updateRecord(projectRoot, updateOptions(update));
    return;
  }
  const path = core.planTransitionPath(current.kind, current.status, update.status);
  for (const status of path.slice(0, -1)) {
    core.updateRecord(projectRoot, { id: current.id, kind: current.kind, status });
  }
  if (path.length > 0 || hasNonStatusUpdate(update)) {
    core.updateRecord(projectRoot, {
      ...updateOptions(update),
      kind: current.kind,
      status: update.status,
    });
  }
}

function createRecord(
  core: Awaited<ReturnType<typeof loadProjectLedgerCore>>,
  projectRoot: string,
  update: ProjectLedgerRecordUpdate,
): void {
  if (!update.kind || !update.title) {
    throw new Error("Project Ledger create effect requires kind and title");
  }
  const options = {
    project: projectRoot,
    ...updateOptions(update),
    ...(update.parentId && update.kind === "task" ? { work: update.parentId } : {}),
    ...(update.parentId && update.kind === "attempt" ? { task: update.parentId } : {}),
  };
  if (update.kind === "work") core.createWork(projectRoot, options);
  else if (update.kind === "task") {
    core.createTask(projectRoot, options);
    applyLifecycleCreateExtras(core, projectRoot, update);
  } else if (update.kind === "attempt") {
    if (update.status && update.status !== "started") {
      throw new Error("Project Ledger attempt create effect requires status started");
    }
    core.createAttempt(projectRoot, options);
    applyLifecycleCreateExtras(core, projectRoot, update);
  } else core.createRecord(projectRoot, options);
}

function applyLifecycleCreateExtras(
  core: Awaited<ReturnType<typeof loadProjectLedgerCore>>,
  projectRoot: string,
  update: ProjectLedgerRecordUpdate,
): void {
  const fields = [
    "spec",
    "acceptance",
    "implementation",
    "mitigation",
    "reason",
    "codeCommits",
    "ledgerCommits",
    "requiresCommitEvidence",
  ] as const;
  const extras = Object.fromEntries(
    fields.flatMap((field) =>
      update[field] === undefined ? [] : [[field, update[field]]],
    ),
  );
  if (Object.keys(extras).length === 0) return;
  core.updateRecord(projectRoot, updateOptions({
    id: update.id,
    kind: update.kind,
    ...extras,
  }));
}

function hasNonStatusUpdate(update: ProjectLedgerRecordUpdate): boolean {
  return Object.entries(update).some(([key, value]) =>
    !["operation", "id", "kind", "parentId", "status"].includes(key) &&
    value !== undefined);
}

function updateOptions(update: ProjectLedgerRecordUpdate): Record<string, unknown> {
  const options = Object.fromEntries(
    Object.entries(update).filter(([key, value]) =>
      value !== undefined &&
      !["operation", "parentId", "requiresCommitEvidence"].includes(key)),
  );
  if (update.requiresCommitEvidence === true) {
    options["requires-commit-evidence"] = true;
  }
  return options;
}
