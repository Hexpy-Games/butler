import { useCallback, useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import type { ArchiveListView } from "@/app/types.ts";
import { Button, Stack, Typo } from "@/butler-ds";
import { ArchiveItemRow } from "./ArchiveItemRow";
import { archiveItems, type ArchiveItem } from "./archiveSettingsUtils";
import { SettingsSection } from "./SettingsSection";

const PAGE_SIZE = 20;

export function ArchivesSettings() {
  const [archives, setArchives] = useState<ArchiveListView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadPage = useCallback((offset = 0) => {
    return api<ArchiveListView>(
      `/archives?limit=${PAGE_SIZE}&offset=${offset}`,
    );
  }, []);

  const refresh = useCallback(async () => {
    setArchives(await loadPage());
  }, [loadPage]);

  const loadMore = async () => {
    if (!archives) return;
    const next = await loadPage(archiveItems(archives).length);
    setArchives({
      ...next,
      projects: [...archives.projects, ...next.projects],
      sessions: [...archives.sessions, ...next.sessions],
    });
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const restore = async (item: ArchiveItem) => {
    setBusyId(item.id);
    try {
      await api(
        item.kind === "project"
          ? `/projects/${encodeURIComponent(item.id)}`
          : `/sessions/${encodeURIComponent(item.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ archived: false }),
        },
      );
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (item: ArchiveItem) => {
    if (!window.confirm(`"${item.title}" 항목을 삭제할까요?`)) return;
    setBusyId(item.id);
    try {
      await api(
        item.kind === "project"
          ? `/projects/${encodeURIComponent(item.id)}?permanent=true`
          : `/sessions/${encodeURIComponent(item.id)}?permanent=true`,
        {
          method: "DELETE",
        },
      );
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const items = archiveItems(archives);

  return (
    <SettingsSection title={appCopy.settings.panels.archives}>
      <Stack gap="md">
        {items.length === 0 ? (
          <Typo.Body>보관된 프로젝트나 대화가 없습니다.</Typo.Body>
        ) : (
          <Stack gap="md">
            {items.map((item) => (
              <ArchiveItemRow
                key={`${item.kind}:${item.id}`}
                item={item}
                busy={busyId === item.id}
                onRestore={() => void restore(item)}
                onRemove={() => void remove(item)}
              />
            ))}
            {archives?.pagination.has_more && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(busyId)}
                onClick={() => void loadMore()}
              >
                {appCopy.common.more}
              </Button>
            )}
          </Stack>
        )}
      </Stack>
    </SettingsSection>
  );
}
