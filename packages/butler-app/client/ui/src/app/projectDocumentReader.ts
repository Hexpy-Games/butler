import { appCopy, getAppLocale } from "./copy.ts";
import { projectDocumentBadgeLabel, projectDocumentMarkdownView } from "./projectDocuments.ts";
import type { ProjectDashboardDocument } from "./types.ts";

export function projectDocumentReaderView(document: ProjectDashboardDocument) {
  const copy = appCopy.projectDocumentMetadata;
  const parsed = projectDocumentMarkdownView(document.markdown);
  const date = new Date(document.updated_at);
  const facts = [
    { id: "kind", label: copy.labels.kind!, value: projectDocumentBadgeLabel(document) },
    ...(document.status ? [{ id: "status", label: copy.labels.status!,
      value: copy.statuses[document.status] ?? document.status }] : []),
    ...(Number.isNaN(date.getTime()) ? [] : [{ id: "updatedAt", label: copy.labels.updatedAt!,
      value: new Intl.DateTimeFormat(getAppLocale(), { dateStyle: "medium", timeStyle: "short" }).format(date) }]),
    ...(document.safe_path_label ? [{ id: "source", label: copy.labels.source!, value: document.safe_path_label }] : []),
  ];
  const details = [
    { key: "id", label: copy.labels.id!, value: document.id },
    ...(document.revision ? [{ key: "revision", label: copy.labels.revision!, value: document.revision }] : []),
    ...parsed.frontmatter.filter((entry) => !["id", "kind", "status", "updatedAt", "updated_at", "revision"].includes(entry.key)),
  ];
  return { facts, details, body: parsed.body };
}
