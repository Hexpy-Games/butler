import {
  PROJECT_DOCUMENT_PICKER_FILTERS,
  projectDocumentType,
} from "@/app/projectDocuments.ts";
import type { ProjectDashboardDocument } from "@/app/types.ts";
import type { FilteredSelectGroup } from "@/butler-ds";
import { BookOpenText, FileText, ListChecks } from "@/butler-ds";

export type ProjectDocumentFilter =
  (typeof PROJECT_DOCUMENT_PICKER_FILTERS)[number]["id"];

type ProjectDocumentGroup = Exclude<ProjectDocumentFilter, "all">;

const PROJECT_DOCUMENT_GROUPS: Array<{
  id: ProjectDocumentGroup;
  title: string;
}> = [
  { id: "spec", title: "Spec" },
  { id: "roadmap", title: "Roadmap" },
  { id: "work", title: "Work" },
  { id: "task", title: "Task" },
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
  return PROJECT_DOCUMENT_GROUPS.map((group) => ({
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
  return type === "plan" ? "work" : type;
}

function documentIcon(document: ProjectDashboardDocument) {
  const type = normalizedProjectDocumentType(document);
  if (type === "roadmap") return <BookOpenText size={15} />;
  if (type === "task") return <ListChecks size={15} />;
  return <FileText size={15} />;
}
