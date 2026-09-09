import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/app/api.ts";
import { notifyError } from "@/app/notifications.ts";
import { projectDocumentPickerFilters } from "@/app/projectDocuments.ts";
import type {
  ProjectDashboardDocument,
} from "@/app/types.ts";
import type { DashboardMaterialsPage } from "../../../../../../butler-agent/src/gateways/app/interface/protocol/session-dashboard-contract.ts";
import {
  ChevronRight,
  FileText,
  FilteredSelectPopover,
  OptionMenuItem,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/butler-ds";
import { useComposerStore } from "./composerStore";
import {
  projectDocumentPickerGroups,
  type ProjectDocumentFilter,
} from "./ComposerProjectDocumentGroups";

export function ComposerProjectDocumentMenu({
  className,
  onClose,
  projectId,
}: {
  className: string;
  onClose: () => void;
  projectId: string | null;
}) {
  useAppLocale();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <OptionMenuItem
          disabled={!projectId}
          icon={<FileText size={15} />}
          label={appCopy.interfaceDetails.projectDocuments}
          description={<ChevronRight size={14} />}
        />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className={className}
        data-glint="composer"
        data-menu-size="content"
        data-nested-menu-align="attachment-bottom"
        side="right"
        sideOffset={8}
      >
        <ComposerProjectDocumentPicker
          projectId={projectId}
          onClose={onClose}
        />
      </PopoverContent>
    </Popover>
  );
}

function ComposerProjectDocumentPicker({
  onClose,
  projectId,
}: {
  onClose: () => void;
  projectId: string | null;
}) {
  useAppLocale();
  const addProjectDocument = useComposerStore(
    (store) => store.addProjectDocument,
  );
  const [documents, setDocuments] = useState<ProjectDashboardDocument[]>([]);
  const [searchValue, setSearchValue] = useState("");
  const [filter, setFilter] = useState<ProjectDocumentFilter>("all");

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setDocuments([]);
    const load = async () => {
      let cursor: string | null = null;
      const documents: ProjectDashboardDocument[] = [];
      do {
        const query: URLSearchParams = new URLSearchParams({ all: "true", limit: "100", ...(cursor ? { cursor } : {}) });
        const page: DashboardMaterialsPage = await api(`/projects/${encodeURIComponent(projectId)}/dashboard/materials?${query}`);
        if (cancelled) return;
        if (page.status !== "ready") break;
        documents.push(...page.documents); cursor = page.nextCursor;
      } while (cursor);
      setDocuments(documents);
    };
    load()
      .catch((error) => {
        if (!cancelled) {
          notifyError(error, appCopy.interfacePanels.projectDocumentsFailed, {
            id: `composer-project-documents-${projectId}`,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const groups = useMemo(() => {
    return projectDocumentPickerGroups({
      addProjectDocument,
      closeMenus: onClose,
      documents,
      filter,
      searchValue,
    });
  }, [addProjectDocument, documents, filter, onClose, searchValue]);

  return (
    <FilteredSelectPopover
      title={appCopy.interfaceDetails.projectDocuments}
      searchLabel={appCopy.interfaceDetails.projectDocuments}
      searchPlaceholder={appCopy.interfaceDetails.searchDocuments}
      searchClearLabel={appCopy.interfaceDetails.clearSearch}
      searchValue={searchValue}
      width="fixed"
      filters={projectDocumentPickerFilters()}
      activeFilterId={filter}
      onFilterChange={(id) => setFilter(id as ProjectDocumentFilter)}
      onSearchChange={setSearchValue}
      emptyLabel={appCopy.interfaceDetails.noDocuments}
      groups={groups}
    />
  );
}
