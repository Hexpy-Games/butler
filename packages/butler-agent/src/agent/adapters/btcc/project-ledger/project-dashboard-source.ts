import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { readExactProjectLedgerSnapshot, revalidateExactLedgerPreconditions } from "./canonical-ledger-reader.ts";
import type { DashboardLedgerSnapshot } from "./project-dashboard-reader.ts";
import { childPath } from "./project-work-json.ts";
import { readManagedProjectWorkChild } from "./project-work-snapshot.ts";
import { PROJECT_WORK_SPEC } from "./project-work-codec.ts";

/** Resolve only a source already admitted by this project's read snapshot. */
export async function readProjectDashboardSource(input: {
  butlerData: string; appProjectId: string; ledgerProjectId: string; snapshot: DashboardLedgerSnapshot;
  kind: string; id: string;
}): Promise<{ title: string; body: string; revision: string; updatedAt: string; status: string }> {
  const { snapshot, kind, id } = input;
  const work = snapshot.works.find((item) => kind === "work" && item.record.id === id);
  const planWork = snapshot.works.find((item) => kind === "plan" && item.managed?.currentPlan?.planRevisionId === id);
  const matches = snapshot.records.filter((item) => item.kind === kind && item.id === id);
  if (matches.length > 1) throw new Error("dashboard_source_ambiguous");
  const target = work?.record ?? (planWork ? {
    id, kind: "plan", parentId: planWork.record.id, title: planWork.managed!.currentPlan!.objective,
    path: childPath(input.ledgerProjectId, "plan", id), updatedAt: planWork.managed!.currentPlan!.createdAt,
    status: planWork.record.status,
  } : matches[0]);
  if (!target || (work && work.availability !== "ready")) throw new Error("dashboard_source_unavailable");
  const exact = await readExactProjectLedgerSnapshot({
    projectRoot: resolve(input.butlerData, "project-ledger", "projects", input.ledgerProjectId), targets: [target],
  });
  const record = exact.records[0];
  if (!record || record.metadata?.schema !== `project-ledger.${kind}.v1`) throw new Error("dashboard_source_unavailable");
  let body = record.body;
  let title = String(record.metadata?.title ?? target.title);
  // Runtime manifests are private storage, not public documents. Expose the
  // complete public report/plan projection, never operation or tool payloads.
  if (work?.managed) {
    if (record.rawRecordSha256 !== work.revision) throw new Error("dashboard_source_changed");
    const view = work.managed;
    title = view.objective;
    body = [`# ${view.objective}`, view.latestDisposition?.summary ?? view.latestCheckpoint?.publicSummary ?? "",
      ...(view.latestDisposition?.remainingActions ?? []).map((text) => `- [ ] ${text}`),
      ...(view.latestDisposition?.followups ?? []).map((text) => `- ${text}`)].filter(Boolean).join("\n\n");
  } else if (kind === "plan" && record.metadata.spec === PROJECT_WORK_SPEC) {
    const parent = planWork ?? snapshot.works.find((item) => item.record.id === target.parentId && item.managed);
    if (!parent) throw new Error("dashboard_source_unavailable");
    const child = await readManagedProjectWorkChild({ butlerData: input.butlerData,
      scope: { appProjectId: input.appProjectId, ledgerProjectId: input.ledgerProjectId,
        ledgerRoot: realpathSync(resolve(input.butlerData, "project-ledger", "projects", input.ledgerProjectId)) },
      workId: parent.record.id, id, kind: "plan", schema: "butler.btcc-project-work-plan.v1" });
    const plan = child.plan;
    title = plan.objective;
    body = [`# ${plan.objective}`, ...plan.actions.map((action) => `- ${action.description}`),
      ...plan.checks.map((check) => `- ${check}`)].join("\n\n");
  }
  await revalidateExactLedgerPreconditions(resolve(input.butlerData, "project-ledger", "projects", input.ledgerProjectId), exact.targetPreconditions);
  return { title, body, revision: record.rawRecordSha256,
    updatedAt: String(record.metadata?.updatedAt ?? target.updatedAt), status: String(record.metadata?.status ?? target.status) };
}
