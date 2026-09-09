import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DurableWorkView } from "../../../btcc/work/index.ts";
import { readExactProjectLedgerSnapshot } from "./canonical-ledger-reader.ts";
import { loadProjectLedgerCore } from "./project-ledger-core.ts";
import { readCurrentProjectWork } from "./project-work-snapshot.ts";
import { PROJECT_WORK_SPEC } from "./project-work-codec.ts";

export type DashboardLedgerRecord = {
  id: string; kind: string; title: string; status: string; path: string;
  parentId: string | null; spec: string | null; updatedAt: string; priority: number;
  unavailable?: boolean;
};
export type DashboardLedgerWork = {
  record: DashboardLedgerRecord;
  revision: string | null;
  availability: "ready" | "unavailable";
  managed: DurableWorkView | null;
};
export type DashboardLedgerSnapshot = {
  revision: string; observedAt: string; records: DashboardLedgerRecord[];
  works: DashboardLedgerWork[];
};

/** Read-only adapter: no index rebuild, import, repair, or runtime projection. */
export function createProjectDashboardLedgerReader(butlerData: string) {
  const cache = new Map<string, { revision: string; snapshot: DashboardLedgerSnapshot }>();
  return async (appProjectId: string, ledgerProjectId: string): Promise<DashboardLedgerSnapshot> => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/u.test(ledgerProjectId)) {
      throw new Error("dashboard_ledger_identity_invalid");
    }
    const requested = resolve(butlerData, "project-ledger", "projects", ledgerProjectId);
    if (lstatSync(requested).isSymbolicLink()) {
      throw new Error("dashboard_ledger_identity_invalid");
    }
    const root = realpathSync(requested);
    for (const path of ["project.json", "index", "index/project.json"]) {
      if (lstatSync(join(root, path)).isSymbolicLink()) throw new Error("dashboard_ledger_identity_invalid");
    }
    const project = JSON.parse(readFileSync(join(root, "project.json"), "utf8"));
    if (project.id !== ledgerProjectId) throw new Error("dashboard_ledger_identity_mismatch");
    const core = await loadProjectLedgerCore();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const publication = core.publicationReadVersion(root);
      const rawIndex = readFileSync(join(root, "index/project.json"), "utf8");
      const records = indexedRecords(rawIndex, ledgerProjectId);
      const sourceMetadata = workSourceMetadata(root, records);
      const revision = digest(`${appProjectId}\0${ledgerProjectId}\0${publication}\0${rawIndex}\0${sourceMetadata}`);
      const key = `${appProjectId}\0${ledgerProjectId}`;
      const cached = cache.get(key);
      if (cached?.revision === revision) return cached.snapshot;
      // Managed publication intentionally defers the derived index. Discover only
      // canonical Work heads, not the entire historical Markdown tree.
      for (const id of workIds(root)) {
        if (!records.some((record) => record.kind === "work" && record.id === id)) records.push({
          id, kind: "work", title: id, status: "unknown", parentId: null, spec: null,
          path: `project-ledger/projects/${ledgerProjectId}/work/${id}/work.md`, updatedAt: "", priority: 100,
        });
      }
      const works: DashboardLedgerWork[] = [];
      // Task and ordinary Plan state is canonical file metadata, not the
      // asynchronously rebuilt index. Read only on a changed snapshot.
      for (let index = 0; index < records.length; index++) {
        const record = records[index]!;
        if (record.kind !== "work") {
          const stat = lstatSync(join(root, record.path.split("/").slice(3).join("/")), { throwIfNoEntry: false });
          if (!stat?.isFile() || stat.isSymbolicLink()) {
            records[index] = { ...record, status: "unknown", unavailable: true }; continue;
          }
        }
        if (!["task", "plan"].includes(record.kind) || record.spec === PROJECT_WORK_SPEC) continue;
        try {
          const source = (await readExactProjectLedgerSnapshot({ projectRoot: root, targets: [record] })).records[0];
          if (!source || source.metadata?.schema !== `project-ledger.${record.kind}.v1` ||
              typeof source.metadata.title !== "string" || typeof source.metadata.status !== "string") throw new Error("dashboard_record_changed");
          records[index] = { ...record, title: source.metadata.title, status: source.metadata.status,
            updatedAt: String(source.metadata.updatedAt ?? record.updatedAt) };
        } catch { records[index] = { ...record, status: "unknown", unavailable: true }; }
      }
      for (const record of records.filter((item) => item.kind === "work")) {
        try {
          const exact = await readExactProjectLedgerSnapshot({ projectRoot: root, targets: [record] });
          const source = exact.records[0];
          if (!source || source.metadata?.schema !== "project-ledger.work.v1" ||
              typeof source.metadata.title !== "string" || typeof source.metadata.status !== "string") {
            throw new Error("dashboard_record_changed");
          }
          const current = { ...record, title: source.metadata.title, status: source.metadata.status,
            spec: typeof source.metadata.spec === "string" ? source.metadata.spec : null,
            updatedAt: String(source.metadata.updatedAt ?? record.updatedAt) };
          const managed = current.spec === PROJECT_WORK_SPEC
            ? (await readCurrentProjectWork({ butlerData, scope: {
              appProjectId, ledgerProjectId, ledgerRoot: root,
            }, workId: record.id }))?.view ?? null : null;
          if (current.spec === PROJECT_WORK_SPEC && !managed) throw new Error("dashboard_managed_missing");
          works.push({ record: current, managed, revision: source.rawRecordSha256, availability: "ready" });
        } catch {
          works.push({ record, managed: null, revision: null, availability: "unavailable" });
        }
      }
      if (publication !== core.publicationReadVersion(root) ||
          rawIndex !== readFileSync(join(root, "index/project.json"), "utf8") ||
          sourceMetadata !== workSourceMetadata(root, records)) continue;
      for (const work of works) {
        const index = records.findIndex((record) => record.kind === "work" && record.id === work.record.id);
        if (index >= 0) records[index] = work.record;
        const plan = work.managed?.currentPlan;
        if (plan && !records.some((record) => record.kind === "plan" && record.id === plan.planRevisionId)) records.push({
          id: plan.planRevisionId, kind: "plan", title: plan.objective, status: "active", parentId: work.record.id,
          spec: PROJECT_WORK_SPEC, priority: 100, updatedAt: plan.createdAt,
          path: `project-ledger/projects/${ledgerProjectId}/plans/${plan.planRevisionId.toLowerCase()}.md`,
        });
      }
      const snapshot = { revision, observedAt: new Date().toISOString(), records, works };
      if (cache.size >= 8) cache.delete(cache.keys().next().value!);
      cache.set(key, { revision, snapshot });
      return snapshot;
    }
    throw new Error("dashboard_ledger_changing");
  };
}

function indexedRecords(raw: string, projectId: string): DashboardLedgerRecord[] {
  const index = JSON.parse(raw);
  if (index.schema !== "project-ledger.index.v1" || index.project?.id !== projectId ||
      !Array.isArray(index.records)) throw new Error("dashboard_index_invalid");
  const keys = new Set<string>();
  return index.records.filter((record: Record<string, unknown>) =>
    ["work", "task", "plan", "spec", "report"].includes(String(record.kind)),
  ).map((record: Record<string, unknown>) => {
    const prefix = `project-ledger/projects/${projectId}/`;
    if (!["id", "kind", "title", "status", "path", "updatedAt"].every((key) => typeof record[key] === "string") ||
        !String(record.path).startsWith(prefix) || String(record.path).split(/[\\/]/u).includes("..") ||
        (record.parentId !== null && typeof record.parentId !== "string")) throw new Error("dashboard_index_invalid");
    const key = `${record.kind}\0${record.id}`;
    if (keys.has(key)) throw new Error("dashboard_index_ambiguous");
    keys.add(key);
    return { ...record, priority: typeof record.priority === "number" ? record.priority : 100,
      spec: typeof record.spec === "string" ? record.spec : null } as DashboardLedgerRecord;
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function workIds(root: string): string[] {
  const directory = join(root, "work");
  return existsSync(directory) ? readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() : [];
}

function workSourceMetadata(root: string, records: DashboardLedgerRecord[]): string {
  const paths = [...records.map((record) => record.path.split("/").slice(3).join("/")),
    ...workIds(root).map((id) => `work/${id}/work.md`)];
  for (const dir of ["plans", "references"]) {
    if (existsSync(join(root, dir))) paths.push(...readdirSync(join(root, dir)).map((name) => `${dir}/${name}`));
  }
  return JSON.stringify([...new Set(paths)].sort().map((path) => {
    const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
    return [path, stat?.ino, stat?.size, stat?.mtimeMs, stat?.ctimeMs];
  }));
}
