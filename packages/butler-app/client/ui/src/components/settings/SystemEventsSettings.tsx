import { useCallback, useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import type { SystemEventListView } from "@/app/types.ts";
import { Button, Stack, Typo } from "@/butler-ds";
import { SettingsSection } from "./SettingsSection";
import { SystemEventCard } from "./SystemEventCard";

const PAGE_SIZE = 20;

export function SystemEventsSettings() {
  const [view, setView] = useState<SystemEventListView | null>(null);
  const [loading, setLoading] = useState(false);

  const loadPage = useCallback((offset = 0) => {
    return api<SystemEventListView>(
      `/system-events?limit=${PAGE_SIZE}&offset=${offset}`,
    );
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setView(await loadPage());
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
    <SettingsSection
      title={settingsCopy.panels.systemEvents}
      description={settingsCopy.descriptions.systemEvents}
    >
      <Stack gap="md">
        <Stack align="row" justify="end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {appCopy.common.refresh}
          </Button>
        </Stack>
        {events.length === 0 ? (
          <Typo.Body>{settingsCopy.descriptions.systemEventsEmpty}</Typo.Body>
        ) : (
          <Stack gap="md">
            {events.map((event) => (
              <SystemEventCard key={event.id} event={event} />
            ))}
            {view?.pagination.has_more && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={loading}
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
