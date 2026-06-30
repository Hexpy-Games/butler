import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import type {
  ProjectDashboardDocumentType,
  ProjectDashboardView,
} from "./protocol.ts";
import { isPathInside } from "./path-safety.ts";

type ProjectDocuments = ProjectDashboardView["documents"];
type ProjectDocumentKind = ProjectDocuments[number]["kind"];
type RedactRoot = { root: string; label: string };

export function readLedgerDocumentsFromRoot(
  root: string,
  safeRootLabel: string,
  redactRoots: RedactRoot[],
): ProjectDocuments {
  if (!isPathInside(root, resolve(root))) return [];
  return [
    ...readLedgerDocumentsInDirectory(
      resolve(root, "specs"),
      "spec",
      `${safeRootLabel}/specs`,
      { redactRoots },
    ),
    ...readLedgerDocumentsInDirectory(
      resolve(root, "plans"),
      "plan",
      `${safeRootLabel}/plans`,
      {
        documentType: "plan",
        redactRoots,
      },
    ),
    ...readLedgerDocumentsInDirectory(
      resolve(root, "roadmaps"),
      "plan",
      `${safeRootLabel}/roadmaps`,
      {
        category: () => "Roadmap",
        documentType: "roadmap",
        redactRoots,
      },
    ),
    ...readLedgerDocumentsInDirectory(
      resolve(root, "work"),
      "plan",
      `${safeRootLabel}/work`,
      {
        category: (_kind, relativeLabel) =>
          projectLedgerWorkCategory(relativeLabel),
        documentType: "work",
        include: (relativeLabel) => relativeLabel.endsWith("/work.md"),
        redactRoots,
      },
    ),
    ...readLedgerDocumentsInDirectory(
      resolve(root, "work"),
      "plan",
      `${safeRootLabel}/work`,
      {
        category: (_kind, relativeLabel) =>
          projectLedgerWorkCategory(relativeLabel),
        documentType: "task",
        include: isProjectLedgerTaskDocument,
        redactRoots,
      },
    ),
  ];
}

export function readLedgerDocumentsInDirectory(
  dir: string,
  kind: ProjectDocumentKind,
  safeLabelPrefix: string,
  options: {
    category?: (kind: ProjectDocumentKind, relativeLabel: string) => string;
    documentType?: ProjectDashboardDocumentType;
    include?: (relativeLabel: string) => boolean;
    redactRoots?: RedactRoot[];
  } = {},
): ProjectDocuments {
  if (!existsSync(dir)) return [];
  const readEntries = (
    currentDir: string,
    relativePrefix = "",
  ): ProjectDocuments =>
    readdirSync(currentDir, { withFileTypes: true }).flatMap((entry) => {
      const relativeLabel = relativePrefix
        ? `${relativePrefix}/${entry.name}`
        : entry.name;
      const path = resolve(currentDir, entry.name);
      if (!isPathInside(dir, path)) return [];
      if (entry.isDirectory()) return readEntries(path, relativeLabel);
      if (!entry.isFile() || !entry.name.endsWith(".md")) return [];
      if (options.include && !options.include(relativeLabel)) return [];
      return readLedgerDocumentFile({
        path,
        fallbackFileName: entry.name,
        kind,
        safePathLabel: `${safeLabelPrefix}/${relativeLabel}`,
        relativeLabel,
        category: options.category,
        documentType: options.documentType,
        redactRoots: options.redactRoots ?? [],
      });
    });
  return readEntries(dir);
}

export function sortProjectLedgerDocuments(
  documents: ProjectDocuments,
): ProjectDocuments {
  return documents.sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at),
  );
}

function readLedgerDocumentFile(input: {
  path: string;
  fallbackFileName: string;
  kind: ProjectDocumentKind;
  safePathLabel: string;
  relativeLabel: string;
  category?: (kind: ProjectDocumentKind, relativeLabel: string) => string;
  documentType?: ProjectDashboardDocumentType;
  redactRoots: RedactRoot[];
}): ProjectDocuments {
  try {
    const stat = statSync(input.path);
    if (!stat.isFile()) return [];
    const documentType = input.documentType ?? input.kind;
    const markdown = sanitizeProjectLedgerMarkdown(
      readFileSync(input.path, "utf8").slice(0, 60_000),
      input.redactRoots,
    );
    return [
      {
        id: `${documentType}:${input.relativeLabel}`,
        kind: input.kind,
        document_type: documentType,
        title: markdownTitle(markdown, input.fallbackFileName),
        category:
          input.category?.(input.kind, input.relativeLabel) ??
          projectLedgerDocumentCategory(input.kind, input.relativeLabel),
        status:
          sanitizeProjectLedgerMarkdown(
            frontmatterValue(markdown, "status") ?? "",
            input.redactRoots,
          ) || undefined,
        safe_path_label: input.safePathLabel,
        markdown,
        updated_at: stat.mtime.toISOString(),
      },
    ];
  } catch {
    return [];
  }
}

function sanitizeProjectLedgerMarkdown(
  text: string,
  redactRoots: RedactRoot[],
): string {
  let safeText = text;
  for (const { root, label } of redactRoots) {
    const normalizedRoot = resolve(root);
    if (normalizedRoot.length <= 1) continue;
    safeText = safeText.replace(
      new RegExp(escapeRegex(normalizedRoot), "gu"),
      label,
    );
  }
  return safeText;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function projectLedgerDocumentCategory(
  kind: ProjectDocumentKind,
  relativeLabel: string,
): string {
  if (kind === "plan") return "Plans";
  const first = relativeLabel.split("/")[0] ?? "";
  const slug = first.replace(/\.md$/iu, "").toLocaleLowerCase("en-US");
  if (slug === "cli" || slug.startsWith("cli-")) return "CLI";
  if (slug.startsWith("agentic-core")) return "Agentic Core";
  if (slug.startsWith("butler-dedicated-client")) return "Dedicated Client";
  if (slug.startsWith("cognition")) return "Cognition";
  if (slug.includes("memory")) return "Memory";
  if (slug.includes("project-ledger")) return "Project Ledger";
  if (slug.includes("runtime") || slug.includes("provider")) return "Runtime";
  return "General";
}

function projectLedgerWorkCategory(relativeLabel: string): string {
  const first = relativeLabel.split("/")[0]?.trim();
  return first || "Work";
}

function isProjectLedgerTaskDocument(relativeLabel: string): boolean {
  return /\/tasks\/(?:[^/]+\.md|[^/]+\/task\.md)$/iu.test(relativeLabel);
}

function frontmatterValue(markdown: string, key: string): string | undefined {
  const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---/u)?.[1];
  if (!frontmatter) return undefined;
  const pattern = new RegExp(
    `^${key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*:\\s*"?([^"\\n]+)"?\\s*$`,
    "imu",
  );
  return frontmatter.match(pattern)?.[1]?.trim();
}

function markdownTitle(markdown: string, fallbackFileName: string): string {
  const heading = markdown.match(/^#\s+(.+)$/mu)?.[1]?.trim();
  if (heading) return heading.slice(0, 120);
  return fallbackFileName
    .replace(/\.md$/iu, "")
    .replace(/[-_]+/gu, " ")
    .slice(0, 120);
}
