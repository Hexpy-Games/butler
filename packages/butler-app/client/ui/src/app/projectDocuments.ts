import type { CSSProperties } from "react";
import type {
  ProjectDashboardDocument,
  ProjectDashboardDocumentType,
} from "./types.ts";

export const PLAN_LANES = [
  { id: "planned", label: "Planned" },
  { id: "active", label: "Active" },
  { id: "done", label: "Done" },
  { id: "other", label: "Other" },
] as const;

export const projectDocumentLayout = {
  planBoard: { alignItems: "stretch" },
  lane: { minWidth: 0 },
  laneInner: { height: "22rem", minHeight: 0 },
  laneScroller: { flex: "1 1 auto", height: "100%", minHeight: 0 },
  specBrowserPanel: {
    display: "grid",
    gridTemplateColumns: "minmax(12rem, 0.34fr) minmax(0, 1fr)",
    minHeight: 0,
    overflow: "hidden",
  },
  specCategoryPane: {
    minWidth: 0,
    borderRight: "1px solid var(--line)",
    paddingRight: "var(--space-md)",
  },
  specDocumentPane: { minWidth: 0, paddingLeft: "var(--space-md)" },
  specScroller: { height: "14.5rem", minHeight: 0 },
} satisfies Record<string, CSSProperties>;

export const projectDocumentDialogLayout = {
  body: {
    position: "relative",
    minHeight: 0,
  },
  markdownPadding: {
    paddingBottom: "72px",
  },
  metadataPanel: {
    display: "grid",
    gap: "var(--space-xs)",
    padding: "var(--space-md)",
  },
  metadataRow: {
    display: "grid",
    gridTemplateColumns: "minmax(7rem, 0.28fr) minmax(0, 1fr)",
    gap: "var(--space-sm)",
    alignItems: "baseline",
  },
  metadataLabel: { color: "var(--text-tertiary)" },
  metadataValue: {
    color: "var(--text-secondary)",
    overflowWrap: "anywhere",
  },
  scroller: {
    height: "min(66vh, 680px)",
    minHeight: "20rem",
  },
  startAction: {
    position: "absolute",
    left: "50%",
    bottom: "var(--space-md)",
    zIndex: 2,
    transform: "translateX(-50%)",
    boxShadow: "var(--shadow-card)",
  },
} satisfies Record<string, CSSProperties>;

export const PLAN_BOARD_TABS = [
  { id: "plan", label: "Plan" },
  { id: "work", label: "Work" },
  { id: "task", label: "Task" },
] as const;

export const PROJECT_DOCUMENT_PICKER_FILTERS = [
  { id: "all", label: "All" },
  { id: "spec", label: "Spec" },
  { id: "roadmap", label: "Roadmap" },
  { id: "work", label: "Work" },
  { id: "task", label: "Task" },
] as const;

export function groupSpecs(
  specs: ProjectDashboardDocument[],
): Array<[string, ProjectDashboardDocument[]]> {
  const groups = new Map<string, ProjectDashboardDocument[]>();
  for (const spec of specs) {
    const category = spec.category?.trim() || "General";
    groups.set(category, [...(groups.get(category) ?? []), spec]);
  }
  return [...groups.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

export function planLane(
  plan: ProjectDashboardDocument,
): (typeof PLAN_LANES)[number]["id"] {
  const status = plan.status?.toLocaleLowerCase("en-US") ?? "";
  if (/done|complete|shipped|closed|reported/u.test(status)) return "done";
  if (/active|progress|running|review|current/u.test(status)) return "active";
  if (/draft|planned|specified|todo|ready|open/u.test(status)) return "planned";
  return "other";
}

export function planBoardType(
  plan: ProjectDashboardDocument,
): (typeof PLAN_BOARD_TABS)[number]["id"] | null {
  const type = projectDocumentType(plan);
  if (type === "plan") return "plan";
  if (type === "task") return "task";
  if (type === "work") return "work";
  return null;
}

export function projectDocumentType(
  document: ProjectDashboardDocument,
): ProjectDashboardDocumentType {
  return document.document_type ?? document.kind;
}

export function projectDocumentBadgeLabel(
  document: ProjectDashboardDocument,
): string {
  const type = projectDocumentType(document);
  if (type === "task") return "Task";
  if (type === "plan") return "Plan";
  if (type === "roadmap") return "Roadmap";
  if (type === "spec") return "Spec";
  return "Work";
}

export function projectDocumentFileName(
  document: ProjectDashboardDocument,
): string {
  const base =
    document.title
      .trim()
      .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
      .replace(/\s+/gu, " ")
      .slice(0, 80)
      .trim() || "project-document";
  return base.toLocaleLowerCase("en-US").endsWith(".md") ? base : `${base}.md`;
}

export interface ProjectDocumentFrontmatterEntry {
  key: string;
  label: string;
  value: string;
}

const FRONTMATTER_LABELS: Record<string, string> = {
  id: "ID",
  kind: "Kind",
  status: "Status",
  updatedAt: "Updated",
  migratedFrom: "Migrated from",
  parent: "Parent",
  owner: "Owner",
  priority: "Priority",
  acceptance: "Acceptance",
  validation: "Validation",
  review: "Review",
  report: "Report",
  implementation: "Implementation",
};

const HIDDEN_FRONTMATTER_KEYS = new Set(["schema", "title"]);

export function projectDocumentMarkdownView(markdown: string): {
  body: string;
  frontmatter: ProjectDocumentFrontmatterEntry[];
} {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/u);
  if (!match) return { body: markdown, frontmatter: [] };
  return {
    body: markdown.slice(match[0].length).trimStart(),
    frontmatter: parseProjectDocumentFrontmatter(match[1] ?? ""),
  };
}

function parseProjectDocumentFrontmatter(
  text: string,
): ProjectDocumentFrontmatterEntry[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/u))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => {
      const key = match[1]!;
      const value = cleanFrontmatterValue(match[2] ?? "");
      return {
        key,
        label: FRONTMATTER_LABELS[key] ?? titleCaseKey(key),
        value,
      };
    })
    .filter((entry) => entry.value && !HIDDEN_FRONTMATTER_KEYS.has(entry.key));
}

function cleanFrontmatterValue(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/gu, "")
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/,\s*/gu, ", ");
}

function titleCaseKey(key: string): string {
  return key
    .replace(/[-_]+/gu, " ")
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/\b\w/gu, (match) => match.toLocaleUpperCase("en-US"));
}
