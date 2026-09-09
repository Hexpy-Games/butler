import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { DashboardLedgerSnapshot } from "../../../../agent/adapters/btcc/project-ledger/index.ts";
import { sanitizePublicText } from "../../../../agent/events/public-text.ts";
import { estimateTokensForModel } from "../../../../integrations/providers/model-catalog.ts";
import { visibleMessageSqlPredicate } from "../sessions/visible-message-sql.ts";
import type { DashboardBriefingSource, DashboardBriefingView } from "../../interface/protocol/session-dashboard-contract.ts";
import { projectReportLocatorRevision } from "./project-report-source.ts";
import { appLocaleFromLanguage, getAppCopy } from "../../../../../../butler-i18n/src/index.ts";

export const PROJECT_BRIEFING_INPUT_TOKENS = 8000;
export const PROJECT_BRIEFING_OUTPUT_TOKENS = 1200;
export const PROJECT_BRIEFING_GENERATOR_VERSION = "signpost-v2";
export interface ProjectBriefingPack {
  projectId: string; binding: string | null; revision: string; language: string;
  model: string; facts: Array<Record<string, unknown>>; description: string;
  sources: DashboardBriefingSource[]; candidates: DashboardBriefingView["candidates"];
  coverage: DashboardBriefingView["coverage"];
}

/** Selected public units only. No transcript, tool payload, or inferred Work relation. */
export function buildProjectBriefingPack(input: {
  db: Database; projectId: string; binding: string | null; description: string | null;
  snapshot: DashboardLedgerSnapshot | null; model: string; language: string; contextTokens: number; reasoningEffort: string;
}): ProjectBriefingPack {
  const { snapshot } = input;
  const safe = (text: string) => sanitizePublicText(text, "");
  const facts: Array<Record<string, unknown>> = [];
  const sources: DashboardBriefingSource[] = [];
  const candidates: ProjectBriefingPack["candidates"] = [];
  const coverage = { totalWorks: snapshot?.works.length ?? 0, includedWorks: 0, includedDocuments: 0, includedReports: 0, excludedUnits: 0 };
  const description = safe(input.description ?? "");
  const budget = Math.min(PROJECT_BRIEFING_INPUT_TOKENS, Math.floor(input.contextTokens * .25));
  const add = (source: DashboardBriefingSource, fact: Record<string, unknown>, proposed: string[], ceiling = budget) => {
    const next = proposed.filter(Boolean).map((text, index) => ({ id: `${source.sourceId}:${index}`, sourceId: source.sourceId, text: safe(text) }));
    // Reserve 1000 tokens for instructions/envelope. Drop complete units, never sever their identity/status.
    if (estimateTokensForModel(JSON.stringify({ description, facts: [...facts, fact], sources: [...sources, source],
      candidates: [...candidates, ...next], coverage }), input.model).tokens + 1000 > ceiling) { coverage.excludedUnits++; return false; }
    sources.push(source); facts.push(fact); candidates.push(...next); return true;
  };
  const works = [...(snapshot?.works ?? [])].sort((a, b) =>
    Number(b.managed?.status === "blocked" || b.record.status === "blocked") - Number(a.managed?.status === "blocked" || a.record.status === "blocked") ||
    a.record.priority - b.record.priority || b.record.updatedAt.localeCompare(a.record.updatedAt) || a.record.id.localeCompare(b.record.id));
  coverage.excludedUnits += Math.max(0, works.length - 20);
  for (const work of works.slice(0, 20)) {
    if (work.availability !== "ready") { coverage.excludedUnits++; continue; }
    const view = work.managed;
    const disposition = view?.latestDisposition;
    const checkpoint = view?.latestCheckpoint;
    const dispositionIsLatest = disposition && (!checkpoint || disposition.createdAt >= checkpoint.createdAt);
    const source: DashboardBriefingSource = { sourceId: `work:${work.record.id}`, kind: "work", id: work.record.id,
      revision: work.revision!, title: safe(view?.objective ?? work.record.title) };
    // Terminal disposition suppresses old checkpoint nextStep and old review corrections.
    const proposed = dispositionIsLatest
      ? [...disposition.remainingActions, ...disposition.followups, ...(disposition.nextCondition ? [disposition.nextCondition] : [])]
      : view?.status === "completed" || view?.status === "abandoned" ? []
      : [checkpoint?.nextStep ?? "", ...(view?.latestResultReview?.corrections ?? []), ...(view?.latestPlanReview?.corrections ?? [])];
    if (!view && ["proposed", "scoped", "specified"].includes(work.record.status)) proposed.push(work.record.title);
    if (add(source, { sourceId: source.sourceId, title: source.title, status: view?.status ?? work.record.status,
      reportedAt: dispositionIsLatest ? disposition.createdAt : checkpoint?.createdAt ?? work.record.updatedAt,
      objective: safe(view?.objective ?? work.record.title),
      summary: safe(dispositionIsLatest ? disposition.summary : checkpoint?.publicSummary ?? "") }, proposed, 1000 + (budget - 1000) * .55)) coverage.includedWorks++;
  }
  const currentPlans = new Set(works.flatMap((work) => work.managed?.currentPlan ? [work.managed.currentPlan.planRevisionId] : []));
  const managedWorkIds = new Set(works.filter((work) => work.managed).map((work) => work.record.id));
  const documents = (snapshot?.records ?? []).filter((record) => !record.unavailable && ["spec", "plan", "report"].includes(record.kind) &&
    !(record.kind === "plan" && managedWorkIds.has(record.parentId ?? "") && !currentPlans.has(record.id)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  coverage.excludedUnits += Math.max(0, documents.length - 12);
  for (const record of documents.slice(0, 12)) {
    const source: DashboardBriefingSource = { sourceId: `${record.kind}:${record.id}`, kind: record.kind as DashboardBriefingSource["kind"],
      id: record.id, revision: snapshot!.revision, title: safe(record.title) };
    const proposed = record.kind === "plan" && !record.parentId && ["active", "draft", "planned", "todo"].includes(record.status) ? [record.title] : [];
    if (add(source, { sourceId: source.sourceId, title: source.title, kind: source.kind, status: record.status,
      parentId: record.parentId, reportedAt: record.updatedAt, metadataOnly: true }, proposed, 1000 + (budget - 1000) * .75)) coverage.includedDocuments++;
  }
  const reports = input.db.query<{ id: string; chat_id: string; title: string; excerpt: string; chars: number; updated_at: string }, [string]>(`
    SELECT m.id, m.chat_id, c.title, substr(m.text, 1, 1200) AS excerpt, length(m.text) AS chars, m.updated_at
    FROM chats c JOIN messages m ON m.chat_id = c.id
    WHERE c.project_id = ? AND m.role = 'assistant' AND m.status = 'delivered' AND ${visibleMessageSqlPredicate("m")}
    ORDER BY m.created_at DESC, m.id DESC LIMIT 7
  `).all(input.projectId);
  coverage.excludedUnits += Math.max(0, reports.length - 6);
  for (const report of reports.slice(0, 6)) {
    const source: DashboardBriefingSource = { sourceId: `message:${report.id}`, kind: "message", id: report.id,
      revision: projectReportLocatorRevision(report), title: safe(report.title), sessionId: report.chat_id };
    if (add(source, { sourceId: source.sourceId, relation: "project_conversation_report_only", reportedAt: report.updated_at,
      excerpt: safe(report.excerpt), excerptTruncated: report.chars > 1200 },
      [getAppCopy(appLocaleFromLanguage(input.language)).projectSignpost.reportQuestion])) coverage.includedReports++;
  }
  const pack = { projectId: input.projectId, binding: input.binding, language: input.language, model: input.model,
    description, facts, sources, candidates, coverage };
  return { ...pack, revision: hash(JSON.stringify({ ...pack, ledgerRevision: snapshot?.revision,
    reasoningEffort: input.reasoningEffort, generator: PROJECT_BRIEFING_GENERATOR_VERSION })) };
}
function hash(text: string) { return createHash("sha256").update(text).digest("hex"); }
