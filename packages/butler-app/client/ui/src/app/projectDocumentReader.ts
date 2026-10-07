import { appCopy, getAppLocale } from "./copy.ts";
import { projectDocumentBadgeLabel, projectDocumentMarkdownView, projectDocumentStatusLabel } from "./projectDocuments.ts";
import type { ProjectDashboardDocument } from "./types.ts";

export function projectDocumentReaderView(document: ProjectDashboardDocument) {
  const copy = appCopy.projectDocumentMetadata;
  const taskExport = document.document_type === "task" && "source_label" in document && document.source_label === "Task document";
  const parsed = projectDocumentMarkdownView(document.markdown);
  const date = new Date(document.updated_at);
  const facts = [
    { id: "kind", label: copy.labels.kind!, value: projectDocumentBadgeLabel(document) },
    ...(document.status ? [{ id: "status", label: copy.labels.status!,
      value: projectDocumentStatusLabel(document) }] : []),
    ...(Number.isNaN(date.getTime()) ? [] : [{ id: "updatedAt", label: copy.labels.updatedAt!,
      value: new Intl.DateTimeFormat(getAppLocale(), { dateStyle: "medium", timeStyle: "short" }).format(date) }]),
    ...(document.safe_path_label ? [{ id: "source", label: copy.labels.source!,
      value: taskExport ? appCopy.taskGraph.detail.document : document.safe_path_label }] : []),
  ];
  const details = [
    { key: "id", label: copy.labels.id!, value: document.id },
    ...(document.revision ? [{ key: "revision", label: copy.labels.revision!, value: document.revision }] : []),
    ...parsed.frontmatter.filter((entry) => !["id", "kind", "status", "updatedAt", "updated_at", "revision"].includes(entry.key)),
  ];
  const headings: Readonly<Record<string, string>> = {
    Goal: appCopy.taskGraph.document.goal,
    "Done criteria": appCopy.taskGraph.document.criteria,
    Predecessors: appCopy.taskGraph.document.after,
  };
  const body = taskExport
    ? parsed.body.replace(/^## (Goal|Done criteria|Predecessors)$/gmu, (_, heading: string) => `## ${headings[heading]}`)
    : parsed.body;
  return { facts, details, body };
}
