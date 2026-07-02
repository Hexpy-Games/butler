import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyError } from "@/app/notifications.ts";
import type { DeveloperLogListView } from "@/app/types.ts";
import { Button, Input, NativeSelect, Stack, Typo } from "@/butler-ds";
import { DeveloperLogRow } from "./DeveloperLogRow";
import type { DeveloperLogTab } from "./developerLogViewerTypes";
import { SettingsSection } from "./SettingsSection";
import styles from "./DeveloperLogsSettings.module.css";

const PAGE_SIZE = 30;

export function DeveloperLogsSettings() {
  const [view, setView] = useState<DeveloperLogListView | null>(null);
  const [query, setQuery] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [kind, setKind] = useState<"all" | "model_turn">("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<DeveloperLogTab>("context");
  const [loading, setLoading] = useState(false);
  const copy = appCopy.settings;
  const logCopy = copy.developerLogViewer;

  const loadPage = useCallback((offset = 0) => {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(offset));
    if (query.trim()) params.set("query", query.trim());
    if (sessionId.trim()) params.set("session_id", sessionId.trim());
    if (kind !== "all") params.set("kind", kind);
    return api<DeveloperLogListView>(`/developer-logs?${params.toString()}`);
  }, [kind, query, sessionId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await loadPage();
      setView(next);
      setOpenId((current) => {
        if (current && next.entries.some((entry) => entry.id === current)) {
          return current;
        }
        return next.entries[0]?.id ?? null;
      });
    } catch (error) {
      notifyError(error, copy.errors.loadDeveloperLogs, {
        id: "settings-developer-logs",
      });
    } finally {
      setLoading(false);
    }
  }, [copy.errors.loadDeveloperLogs, loadPage]);

  const loadMore = async () => {
    if (!view || loading) return;
    setLoading(true);
    try {
      const next = await loadPage(view.entries.length);
      setView({
        ...next,
        entries: [...view.entries, ...next.entries],
      });
    } catch (error) {
      notifyError(error, copy.errors.loadDeveloperLogs, {
        id: "settings-developer-logs-more",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const entries = view?.entries ?? [];
  const openEntry = useMemo(
    () => entries.find((entry) => entry.id === openId) ?? null,
    [entries, openId],
  );

  return (
    <SettingsSection
      title={copy.panels.developerLogs}
      description={copy.descriptions.developerLogs}
    >
      <Stack gap="md">
        <div className={styles.toolbar}>
          <Input
            value={query}
            placeholder={copy.placeholders.developerLogSearch}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <Input
            value={sessionId}
            placeholder={copy.placeholders.developerLogSession}
            onChange={(event) => setSessionId(event.currentTarget.value)}
          />
          <NativeSelect value={kind} size="sm" onChange={(event) =>
            setKind(event.currentTarget.value === "model_turn" ? "model_turn" : "all")
          }>
            <option value="all">{logCopy.filters.allKinds}</option>
            <option value="model_turn">{logCopy.filters.modelTurn}</option>
          </NativeSelect>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {appCopy.common.refresh}
          </Button>
        </div>

        {entries.length === 0 ? (
          <Typo.Body>{copy.descriptions.developerLogsEmpty}</Typo.Body>
        ) : (
          <div className={styles.list}>
            {entries.map((entry) => (
              <DeveloperLogRow
                key={entry.id}
                entry={entry}
                open={entry.id === openEntry?.id}
                tab={tab}
                copy={logCopy}
                onTabChange={setTab}
                onToggle={() => setOpenId((current) => current === entry.id ? null : entry.id)}
              />
            ))}
          </div>
        )}

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
    </SettingsSection>
  );
}
