import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import type { DashboardLedgerSnapshot, DashboardLedgerWork } from "./project-dashboard-reader.ts";
import { readManagedProjectWorkChild } from "./project-work-snapshot.ts";
import type { ProjectWorkChild } from "./project-work-child-codec.ts";
import { loadProjectLedgerCore } from "./project-ledger-core.ts";

export type DashboardWorkHistoryEntry = {
  id: string; workId: string; sessionId: string; at: string;
  action: "reviewed" | "disposition" | "result";
  title: string; body: string; revision: string; status: string;
};

/** Historical children are admitted by the existing strict Work/proof reader.
 * Cache only bounded public projections, never manifests or tool payloads. */
export function createProjectDashboardWorkHistoryReader(butlerData: string) {
  const projects = new Map<string, Map<string, { revision: string; entries: DashboardWorkHistoryEntry[] }>>();
  const discoveries = new Map<string, { revision: string; children: Array<{ workId: string; id: string; schema: ProjectWorkChild["schema"]; stamp: string }> }>();
  return async (appProjectId: string, ledgerProjectId: string, snapshot: DashboardLedgerSnapshot, workId?: string) => {
    const key = `${appProjectId}\0${ledgerProjectId}`;
    let cache = projects.get(key);
    if (!cache) {
      if (projects.size >= 4) { const oldest = projects.keys().next().value!; projects.delete(oldest); discoveries.delete(oldest); }
      cache = new Map(); projects.set(key, cache);
    }
    const scope = { appProjectId, ledgerProjectId, ledgerRoot: realpathSync(resolve(butlerData, "project-ledger/projects", ledgerProjectId)) };
    let discovery = discoveries.get(key);
    if (discovery?.revision !== snapshot.revision) {
      const core = await loadProjectLedgerCore();
      const directory = resolve(scope.ledgerRoot, "references");
      const children: NonNullable<typeof discovery>["children"] = [];
      if (existsSync(directory)) {
        if (lstatSync(directory).isSymbolicLink()) throw new Error("dashboard_history_unavailable");
        const owners = new Set(snapshot.works.filter((work) => work.managed).map((work) => work.record.id));
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
          const path = resolve(directory, entry.name);
          const stat = lstatSync(path);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) continue;
          const metadata = core.readRecordData(path);
          if (!metadata || typeof metadata.parentId !== "string" || !owners.has(metadata.parentId)) continue;
          const body = core.readRecordBody(path);
          let schema: string;
          try { schema = String(JSON.parse(body ?? "").schema); } catch { continue; }
          if (!["butler.btcc-project-work-review.v1", "butler.btcc-project-work-disposition.v1", "butler.btcc-project-work-result-reference.v1"].includes(schema)) continue;
          children.push({ workId: metadata.parentId, id: String(metadata.id), schema: schema as ProjectWorkChild["schema"],
            stamp: `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` });
        }
      }
      discovery = { revision: snapshot.revision, children }; discoveries.set(key, discovery);
    }
    const entries: DashboardWorkHistoryEntry[] = [];
    for (const work of snapshot.works.filter((work) => work.managed && work.availability === "ready" && (!workId || work.record.id === workId))) {
      const cached = cache.get(work.record.id);
      const targets = discovery.children.filter((child) => child.workId === work.record.id);
      const revision = createHash("sha256").update(JSON.stringify([work.revision, targets.map((child) => [child.id, child.stamp])])).digest("hex");
      if (cached?.revision === revision) { entries.push(...cached.entries); continue; }
      const projected: DashboardWorkHistoryEntry[] = [];
      for (const target of targets) {
        const child = await readManagedProjectWorkChild({ butlerData, scope, ...target, kind: "reference" });
        const event = projectChild(child, work);
        if (event) projected.push(event);
      }
      cache.set(work.record.id, { revision, entries: projected });
      entries.push(...projected);
    }
    for (const id of cache.keys()) if (!snapshot.works.some((work) => work.record.id === id)) cache.delete(id);
    return entries;
  };
}

function projectChild(child: ProjectWorkChild, work: DashboardLedgerWork): DashboardWorkHistoryEntry | null {
  let id: string; let at: string; let action: DashboardWorkHistoryEntry["action"]; let status: string; let value: unknown;
  if (child.schema === "butler.btcc-project-work-review.v1") {
    const review = child.review;
    id = review.reviewRevisionId; at = review.createdAt; action = "reviewed"; status = review.verdict;
    value = { subject: review.subject, verdict: review.verdict, summary: review.summary, corrections: review.corrections };
  } else if (child.schema === "butler.btcc-project-work-disposition.v1") {
    const disposition = child.disposition;
    id = disposition.dispositionRevisionId; at = disposition.createdAt; action = "disposition"; status = disposition.disposition;
    value = { disposition: disposition.disposition, summary: disposition.summary, remainingActions: disposition.remainingActions,
      nextCondition: disposition.nextCondition, followups: disposition.followups };
  } else if (child.schema === "butler.btcc-project-work-result-reference.v1") {
    const result = child.result;
    id = result.resultRef; at = result.attachedAt; action = "result"; status = result.status;
    value = { toolName: result.toolName, status: result.status, recordedAt: result.attachedAt };
  } else return null;
  const body = JSON.stringify(value, null, 2);
  return { id: `${work.record.id}|${id}`, workId: work.record.id, sessionId: work.managed!.sessionId,
    at, action, status, title: work.managed!.objective, body,
    revision: createHash("sha256").update(`${work.record.id}\0${id}\0${body}`).digest("hex") };
}
