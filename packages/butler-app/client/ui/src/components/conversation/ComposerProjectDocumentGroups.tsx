import { appCopy } from "@/app/copy.ts";
import {
  projectDocumentPickerFilters,
  projectDocumentType,
} from "@/app/projectDocuments.ts";
import type { ProjectDashboardDocument } from "@/app/types.ts";
import type { FilteredSelectGroup } from "@/butler-ds";
import { BookOpenText, FileText, ListChecks } from "@/butler-ds";

export type ProjectDocumentFilter =
  ReturnType<typeof projectDocumentPickerFilters>[number]["id"];

type ProjectDocumentGroup = Exclude<ProjectDocumentFilter, "all">;

const projectDocumentGroups = (): Array<{
  id: ProjectDocumentGroup;
  title: string;
}> => [
  { id: "spec", title: appCopy.interfaceStatus.spec },
  { id: "roadmap", title: appCopy.projectDocumentMetadata.roadmap },
  { id: "work", title: appCopy.interfaceStatus.work },
  { id: "plan", title: appCopy.composer.plan },
  { id: "report", title: appCopy.interfaceStatus.report },
  { id: "task", title: appCopy.interfaceStatus.task },
];

export function projectDocumentPickerGroups({
  addProjectDocument,
  closeMenus,
  documents,
  filter,
  searchValue,
}: {
  addProjectDocument: (document: ProjectDashboardDocument) => Promise<void>;
  closeMenus: () => void;
  documents: ProjectDashboardDocument[];
  filter: ProjectDocumentFilter;
  searchValue: string;
}): FilteredSelectGroup[] {
  const visible = filterProjectDocuments(documents, filter, searchValue);
  return projectDocumentGroups().map((group) => ({
    ...group,
    items: visible
      .filter((document) => documentBelongsToGroup(document, group.id))
      .map((document) => ({
        id: document.id,
        label: document.title,
        tooltipLabel: document.title,
        icon: documentIcon(document),
        onSelect: () => {
          void addProjectDocument(document);
          closeMenus();
        },
      })),
  }));
}

function filterProjectDocuments(
  documents: ProjectDashboardDocument[],
  filter: ProjectDocumentFilter,
  searchValue: string,
): ProjectDashboardDocument[] {
  const query = searchValue.trim().toLocaleLowerCase();
  return documents.filter((document) => {
    if (document.document_type === "artifact") return false;
    const type = normalizedProjectDocumentType(document);
    if (filter !== "all" && type !== filter) return false;
    return !query || document.title.toLocaleLowerCase().includes(query);
  });
}

function documentBelongsToGroup(
  document: ProjectDashboardDocument,
  group: ProjectDocumentGroup,
): boolean {
  return normalizedProjectDocumentType(document) === group;
}

function normalizedProjectDocumentType(
  document: ProjectDashboardDocument,
): ProjectDocumentGroup {
  const type = projectDocumentType(document);
  return type === "message" || type === "reference" || type === "artifact" ? "report" : type;
}

function documentIcon(document: ProjectDashboardDocument) {
  const type = normalizedProjectDocumentType(document);
  if (type === "roadmap") return <BookOpenText size={15} />;
  if (type === "task") return <ListChecks size={15} />;
  return <FileText size={15} />;
}
