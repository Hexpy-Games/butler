import { useEffect, useMemo, useState } from "react";
import { api } from "@/app/api.ts";
import { notifyError } from "@/app/notifications.ts";
import { PROJECT_DOCUMENT_PICKER_FILTERS } from "@/app/projectDocuments.ts";
import type {
  ProjectDashboardDocument,
  ProjectDashboardView,
} from "@/app/types.ts";
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
  return (
    <Popover>
      <PopoverTrigger asChild>
        <OptionMenuItem
          disabled={!projectId}
          icon={<FileText size={15} />}
          label="프로젝트 문서"
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
  const addProjectDocument = useComposerStore(
    (store) => store.addProjectDocument,
  );
  const [documents, setDocuments] = useState<ProjectDashboardDocument[]>([]);
  const [searchValue, setSearchValue] = useState("");
  const [filter, setFilter] = useState<ProjectDocumentFilter>("all");

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api<ProjectDashboardView>(
      `/projects/${encodeURIComponent(projectId)}/dashboard`,
    )
      .then((dashboard) => {
        if (!cancelled) setDocuments(dashboard.documents);
      })
      .catch((error) => {
        if (!cancelled) {
          notifyError(error, "Project documents failed", {
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
      title="프로젝트 문서"
      searchLabel="프로젝트 문서"
      searchPlaceholder="문서 제목 검색"
      searchClearLabel="검색 지우기"
      searchValue={searchValue}
      width="fixed"
      filters={PROJECT_DOCUMENT_PICKER_FILTERS}
      activeFilterId={filter}
      onFilterChange={(id) => setFilter(id as ProjectDocumentFilter)}
      onSearchChange={setSearchValue}
      emptyLabel="프로젝트 문서가 없습니다."
      groups={groups}
    />
  );
}
