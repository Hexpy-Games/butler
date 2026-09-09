import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  readStableExactProjectLedgerSnapshot,
  type ExactLedgerTarget,
} from "../canonical-ledger-reader.ts";
import type { ProjectLedgerRecordUpdate } from "../external-effect-record-update.ts";
import type { ProjectLedgerCore } from "../project-ledger-core.ts";

export type ExactProjectLedgerScope = {
  ledgerRoot: string;
  ledgerProjectId: string;
};

export function resolveExactProjectLedgerScope(projectRoot: string): ExactProjectLedgerScope {
  const ledgerRoot = realpathSync(resolve(projectRoot));
  const project = JSON.parse(readFileSync(join(ledgerRoot, "project.json"), "utf8")) as {
    id?: unknown;
  };
  const ledgerProjectId = exactProjectId(project.id);
  if (basename(ledgerRoot) !== ledgerProjectId) invalidProjectIdentity();
  return { ledgerRoot, ledgerProjectId };
}

export function hasUnsupportedLegacyProjectLedgerOccurrence(input: {
  butlerData: string;
  projectRoots: string[];
  effectKey: string;
}): boolean {
  const root = join(
    resolve(input.butlerData),
    "runtime",
    "btcc-project-ledger-effects",
    "occurrences",
  );
  return [...new Set(input.projectRoots)].some((projectRoot) => {
    const occurrenceId = createHash("sha256")
      .update(JSON.stringify({
        effectKey: input.effectKey,
        projectRoot,
        schema: "butler.btcc-project-ledger-effect.v1",
      }))
      .digest("hex");
    return existsSync(join(root, `${occurrenceId}.json`));
  });
}

export async function captureExactPublicationAttempt(input: {
  core: ProjectLedgerCore;
  projectRoot: string;
  projectId: string;
  updates: ProjectLedgerRecordUpdate[];
}) {
  return readStableExactProjectLedgerSnapshot({
    projectRoot: input.projectRoot,
    targets: exactTargets(input.core, input.projectRoot, input.projectId, input.updates),
  });
}

function exactTargets(
  core: ProjectLedgerCore,
  projectRoot: string,
  projectId: string,
  updates: ProjectLedgerRecordUpdate[],
): ExactLedgerTarget[] {
  const index = core.buildIndex(projectRoot);
  const prefix = `project-ledger/projects/${projectId}/`;
  return updates.map((update) => {
    const matches = index.records.filter(
      (record) => record.id === update.id && (!update.kind || record.kind === update.kind),
    );
    if (matches.length > 1) throw new Error("project_ledger_exact_target_ambiguous");
    if (!matches[0]) return absentTarget(index.records, prefix, update);
    const data = core.readRecordData(core.projectPath(projectRoot, matches[0].path));
    if (!data) throw new Error("project_ledger_exact_frontmatter_corrupt");
    return {
      id: update.id,
      kind: matches[0].kind,
      path: matches[0].path,
      parentId: stringOrNull(data.parentId),
    };
  });
}

function absentTarget(
  records: Array<{ id: string; kind: string; path: string }>,
  prefix: string,
  update: ProjectLedgerRecordUpdate,
): ExactLedgerTarget {
  if (update.operation !== "create" || !update.kind) {
    throw new Error("project_ledger_exact_record_missing");
  }
  safeRecordId(update.id);
  let path: string;
  if (update.kind === "work") path = `${prefix}work/${update.id}/work.md`;
  else if (update.kind === "task") {
    safeRecordId(update.parentId);
    path = `${prefix}work/${update.parentId}/tasks/${update.id}.md`;
  } else if (update.kind === "attempt") {
    safeRecordId(update.parentId);
    const tasks = records.filter(
      (record) => record.kind === "task" && record.id === update.parentId,
    );
    if (tasks.length !== 1) throw new Error("project_ledger_exact_parent_invalid");
    path = `${tasks[0]!.path.slice(0, -3)}/attempts/${update.id}.md`;
  } else {
    const directory = TOP_LEVEL_DIRECTORIES[update.kind];
    if (!directory) throw new Error("project_ledger_effect_kind_invalid");
    path = `${prefix}${directory}/${update.id.toLocaleLowerCase("en-US")}.md`;
  }
  return { id: update.id, kind: update.kind, path, parentId: update.parentId ?? null };
}

const TOP_LEVEL_DIRECTORIES: Record<string, string> = {
  initiative: "initiatives",
  decision: "decisions",
  risk: "risks",
  spec: "specs",
  report: "reports",
  plan: "plans",
  handoff: "handoffs",
  reference: "references",
  roadmap: "roadmaps",
};

function exactProjectId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return invalidProjectIdentity();
  const exact = value.trim();
  const normalized = exact
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
  if (!normalized || exact !== normalized) return invalidProjectIdentity();
  return exact;
}

function safeRecordId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value.trim() || value === "." || value === ".." || /[\\/]/u.test(value)
  ) {
    throw new Error("project_ledger_record_identity_invalid");
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function invalidProjectIdentity(): never {
  throw new Error("project_ledger_project_identity_invalid");
}
