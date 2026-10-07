import { useButlerStore } from "@/app/store";
import { subscribeGeneralChatCleared } from "@/app/generalChatEvents";
import { useAppLocale } from "@/app/copy.ts";
import { useCallback, useEffect, useState } from "react";
import { notifyError } from "@/app/notifications";
import { api } from "@/app/api.ts";
import { confirmAction } from "@/app/confirmation.ts";
import { appCopy } from "@/app/copy.ts";
import type { ArchiveListView } from "@/app/types.ts";
import { Button } from "@/butler-ds";
import { ArchiveItemRow } from "./ArchiveItemRow";
import { archiveItems, type ArchiveItem } from "./archiveSettingsUtils";
import { SettingsPage, SettingsSection } from "./SettingsFormComponents";

const PAGE_SIZE = 20;

export function ArchivesSettings() {
  useAppLocale();
  const [archives, setArchives] = useState<ArchiveListView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const loadPage = useCallback((offset = 0) => {
    return api<ArchiveListView>(
      `/archives?limit=${PAGE_SIZE}&offset=${offset}`,
    );
  }, []);

  const refresh = useCallback(async () => {
    setLoadFailed(false);
    try {
      setArchives(await loadPage());
    } catch {
      setLoadFailed(true);
    }
  }, [loadPage]);

  const loadMore = async () => {
    if (!archives) return;
    try {
      const next = await loadPage(archiveItems(archives).length);
      setArchives({
        ...next,
        projects: [...archives.projects, ...next.projects],
        sessions: [...archives.sessions, ...next.sessions],
      });
    } catch (error) {
      notifyError(error, appCopy.settings.archiveErrors.loadMore);
    }
  };

  useEffect(() => {
    void refresh();
    return subscribeGeneralChatCleared(() => { void refresh(); });
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
    } catch (error) {
      notifyError(error, appCopy.settings.archiveErrors.restore);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (item: ArchiveItem) => {
    if (!await confirmAction(appCopy.interfaceTemplates.deleteItem(item.title), {
      title: appCopy.common.delete, confirmLabel: appCopy.common.delete, destructive: true,
    })) return;
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
    <SettingsPage>
      <SettingsSection
        id="archives"
        kind="list"
        state={archives === null ? (loadFailed ? "error" : "loading") : items.length === 0 ? "empty" : "ready"}
        emptyMessage={appCopy.interfaceDetails.archivesEmpty}
        onRetry={() => void refresh()}
      >
        {items.map((item) => (
          <ArchiveItemRow
            key={`${item.kind}:${item.id}`}
            item={item}
            onOpen={item.kind === "session" ? () => useButlerStore.getState().openSession(item.id, item.title) : undefined}
            busy={busyId === item.id}
            onRestore={() => void restore(item)}
            onRemove={() => void remove(item)}
          />
        ))}
        {archives?.pagination.has_more && (
          <Button type="button" size="sm" variant="outline" disabled={Boolean(busyId)} onClick={() => void loadMore()}>
            {appCopy.common.more}
          </Button>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
