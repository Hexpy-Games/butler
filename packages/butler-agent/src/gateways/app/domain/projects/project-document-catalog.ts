import { resolve } from "node:path";
import type { ProjectDashboardView } from "../../interface/protocol/app-protocol.ts";
import { isPathInside } from "../../infrastructure/core/path-safety.ts";
import {
  projectLedgerDataRootCandidates,
  type ProjectDocumentSourceProject,
} from "./project-ledger-document-sources.ts";
import {
  readLedgerDocumentsFromRoot,
  readLedgerDocumentsInDirectory,
  sortProjectLedgerDocuments,
} from "./project-ledger-document-reader.ts";

type ProjectDocuments = ProjectDashboardView["documents"];

export type ProjectDocumentCatalog = {
  documents: ProjectDocuments;
  stats: {
    specs: number;
    plans: number;
  };
  briefingDocuments: Array<{
    title: string;
    category: string;
    status?: string;
    safePathLabel: string;
    markdown: string;
  }>;
};

export function loadProjectDocumentCatalog(input: {
  butlerDataRoot: string;
  project: ProjectDocumentSourceProject;
}): ProjectDocumentCatalog {
  const documents = readProjectDocuments(input.butlerDataRoot, input.project);
  return {
    documents,
    stats: summarizeProjectDocuments(documents),
    briefingDocuments: documents.map((document) => ({
      title: document.title,
      category: document.category ?? "General",
      status: document.status,
      safePathLabel: document.safe_path_label,
      markdown: document.markdown,
    })),
  };
}

function summarizeProjectDocuments(
  documents: ProjectDocuments,
): ProjectDocumentCatalog["stats"] {
  return {
    specs: documents.filter((document) => document.kind === "spec").length,
    plans: documents.filter(
      (document) => (document.document_type ?? document.kind) === "plan",
    ).length,
  };
}

function readProjectDocuments(
  butlerDataRoot: string,
  project: ProjectDocumentSourceProject,
): ProjectDocuments {
  const canonicalDocuments = readCanonicalProjectLedgerDocuments(
    butlerDataRoot,
    project,
  );
  if (canonicalDocuments.length > 0) return canonicalDocuments;
  return readWorkspaceProjectLedgerDocuments(project);
}

function readCanonicalProjectLedgerDocuments(
  butlerDataRoot: string,
  project: ProjectDocumentSourceProject,
): ProjectDocuments {
  for (const candidate of projectLedgerDataRootCandidates(
    butlerDataRoot,
    project,
  )) {
    const documents = readLedgerDocumentsFromRoot(
      candidate.root,
      candidate.safeRootLabel,
      [{ root: butlerDataRoot, label: "butler-data" }],
    );
    if (documents.length > 0) return sortProjectLedgerDocuments(documents);
  }
  return [];
}

function readWorkspaceProjectLedgerDocuments(
  project: ProjectDocumentSourceProject,
): ProjectDocuments {
  const workspacePath = project.workspace_path;
  if (!workspacePath) return [];

  const workspaceRoot = resolve(workspacePath, ".project-ledger");
  if (!isPathInside(workspacePath, workspaceRoot)) return [];

  const redactRoots = [{ root: workspacePath, label: "workspace" }];
  return sortProjectLedgerDocuments([
    ...readLedgerDocumentsInDirectory(
      resolve(workspaceRoot, "specs"),
      "spec",
      "workspace/.project-ledger/specs",
      { redactRoots },
    ),
    ...readLedgerDocumentsInDirectory(
      resolve(workspaceRoot, "plans"),
      "plan",
      "workspace/.project-ledger/plans",
      {
        documentType: "plan",
        redactRoots,
      },
    ),
    ...readLedgerDocumentsInDirectory(
      resolve(workspaceRoot, "roadmaps"),
      "plan",
      "workspace/.project-ledger/roadmaps",
      {
        category: () => "Roadmap",
        documentType: "roadmap",
        redactRoots,
      },
    ),
    ...readLedgerDocumentsInDirectory(
      resolve(workspaceRoot, "work"),
      "plan",
      "workspace/.project-ledger/work",
      {
        category: (_kind, relativeLabel) =>
          projectLedgerWorkCategory(relativeLabel),
        documentType: "work",
        include: (relativeLabel) => relativeLabel.endsWith("/work.md"),
        redactRoots,
      },
    ),
    ...readLedgerDocumentsInDirectory(
      resolve(workspaceRoot, "work"),
      "plan",
      "workspace/.project-ledger/work",
      {
        category: (_kind, relativeLabel) =>
          projectLedgerWorkCategory(relativeLabel),
        documentType: "task",
        include: isProjectLedgerTaskDocument,
        redactRoots,
      },
    ),
  ]);
}

function isProjectLedgerTaskDocument(relativeLabel: string): boolean {
  return /\/tasks\/(?:[^/]+\.md|[^/]+\/task\.md)$/iu.test(relativeLabel);
}

function projectLedgerWorkCategory(relativeLabel: string): string {
  const first = relativeLabel.split("/")[0]?.trim();
  return first || "Work";
}
