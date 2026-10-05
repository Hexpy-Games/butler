import { HARNESS_SS03_OBSERVER_VIEW } from "@/app/fixtures";
import type { ProjectDashboardDocument, SessionView, SessionViewStatus } from "@/app/types";
import type { ProposalLocale, TaskGraphCopy } from "./copy";
import { sessionIdOf, type TaskGraph, type TaskNode } from "./fixture";

// What a node links to, built from the fixture: the worker's session view (rendered by the real
// SessionObserverDialog) and the task document (rendered by the real ProjectDocumentDialog).

const SESSION_STATUS: Partial<Record<TaskNode["status"], SessionViewStatus>> = {
  running: "active", completed: "delivered", failed: "failed", cancelled: "cancelled",
};

const RESULT: Record<ProposalLocale, Partial<Record<TaskNode["status"], string>>> = {
  "ko-KR": { completed: "끝났습니다. 결과를 정리해 두었습니다.", failed: "끝내지 못했습니다.", cancelled: "요청에 따라 멈췄습니다." },
  "en-US": { completed: "Done. The result is written up.", failed: "Could not finish.", cancelled: "Stopped as asked." },
};

export function taskSessionView(node: TaskNode, locale: ProposalLocale): SessionView | null {
  const id = sessionIdOf(node);
  if (!id) return null;
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 5, 9, minutes)).toISOString();
  const steps = node.steps.map((step, i) => ({
    ...HARNESS_SS03_OBSERVER_VIEW.messages[0]!,
    id: `${id}-m${i}`, chat_id: id, turn_id: `${id}-turn`, status: "sent" as const, cursor: i + 1,
    text: step[locale], created_at: at(i + 1), updated_at: at(i + 1),
  }));
  const result = RESULT[locale][node.status];
  const running = node.status === "running";
  const base = HARNESS_SS03_OBSERVER_VIEW;
  return {
    ...base,
    session_id: id,
    status: SESSION_STATUS[node.status] ?? "idle",
    active_turn: running ? base.active_turn : null,
    latest_turn: running ? base.latest_turn : null,
    messages: [
      ...(running ? steps.slice(0, 1) : steps),
      ...(result ? [{ ...steps[0]!, id: `${id}-result`, text: node.reason ? `${result} ${node.reason[locale]}` : result, cursor: 99, created_at: at(30), updated_at: at(30) }] : []),
    ],
    relation: base.relation ? { ...base.relation, child_session_id: id, safe_title: node.title[locale] } : undefined,
  };
}

/** The task document: the Task record's export plus its spec link and done criteria. */
export function taskDocument(node: TaskNode, graph: TaskGraph, copy: TaskGraphCopy, locale: ProposalLocale): ProjectDashboardDocument {
  const after = graph.edges.filter((edge) => edge.to === node.id)
    .map((edge) => graph.nodes.find((item) => item.id === edge.from)!.title[locale]);
  const criteria = node.criteria ?? [{ "ko-KR": `${node.title["ko-KR"]} 결과를 근거와 함께 남긴다`, "en-US": `Record the result of "${node.title["en-US"]}" with evidence` }];
  const doc = copy.document;
  const markdown = [
    "---",
    `id: TASK-${node.id.toUpperCase()}`,
    `status: ${DOC_STATUS[node.status]}`,
    `parent: ${node.spec ?? "SPEC-NOTE-APPS"}`,
    ...(node.assignee ? [`owner: ${copy.assignee(node.assignee.ordinal)}`] : []),
    "---",
    `## ${doc.goal}`,
    node.title[locale],
    `## ${doc.criteria}`,
    ...criteria.map((item) => `- ${item[locale]}`),
    `## ${doc.after}`,
    ...(after.length ? after.map((title) => `- ${title}`) : [`- ${copy.detail.none}`]),
  ].join("\n");
  return {
    id: `TASK-${node.id.toUpperCase()}`, kind: "plan", document_type: "task",
    title: node.title[locale], status: DOC_STATUS[node.status],
    safe_path_label: `tasks/${node.id}.md`, markdown, updated_at: "2026-10-05T09:30:00.000Z",
  };
}

const DOC_STATUS: Record<TaskNode["status"], string> = {
  pending: "planned", running: "in_progress", awaiting_review: "review", completed: "done",
  failed: "blocked", cancelled: "cancelled", blocked: "blocked", paused: "in_progress",
};
