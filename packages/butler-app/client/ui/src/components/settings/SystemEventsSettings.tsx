import { useAppLocale } from "@/app/copy.ts";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import type { SystemEventListView } from "@/app/types.ts";
import { Button } from "@/butler-ds";
import { SettingsPage, SettingsSection } from "./SettingsFormComponents";
import { SystemEventCard } from "./SystemEventCard";

const PAGE_SIZE = 20;

export function SystemEventsSettings() {
  useAppLocale();
  const [view, setView] = useState<SystemEventListView | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const loadPage = useCallback((offset = 0) => {
    return api<SystemEventListView>(
      `/system-events?limit=${PAGE_SIZE}&offset=${offset}`,
    );
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      setView(await loadPage());
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [loadPage]);

  const loadMore = async () => {
    if (!view || loading) return;
    setLoading(true);
    try {
      const nextView = await loadPage(view.events.length);
      setView({
        ...nextView,
        events: [...view.events, ...nextView.events],
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const events = view?.events ?? [];
  const settingsCopy = appCopy.settings;

  return (
    <SettingsPage>
      <SettingsSection
        id="system-events"
        kind="list"
        description={settingsCopy.descriptions.systemEvents}
        state={view === null ? (loadFailed ? "error" : "loading") : events.length === 0 ? "empty" : "ready"}
        emptyMessage={settingsCopy.descriptions.systemEventsEmpty}
        onRetry={() => void refresh()}
        actions={
          <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void refresh()}>
            {appCopy.common.refresh}
          </Button>
        }
      >
        {events.map((event) => (
          <SystemEventCard key={event.id} event={event} />
        ))}
        {view?.pagination.has_more && (
          <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void loadMore()}>
            {appCopy.common.more}
          </Button>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
