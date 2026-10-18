import { useCallback, useEffect, useRef, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Button, Presence } from "@/butler-ds";
import { DeveloperUsageSections } from "../DeveloperUsageSections";
import { SettingsPage, SettingsSection } from "../SettingsFormComponents";
import { LogFilters } from "./LogFilters";
import { LogLevelFields } from "./LogLevelFields";
import { LogRows } from "./LogRows";
import { LogStorageActions, LogStoreMeters, useLogStorage } from "./LogStorage";
import { useLogConfig } from "./useLogConfig";
import { useLogViewer } from "./useLogViewer";

/** Settings › 로그 (developer mode): 기록, 로그, 저장 공간, then context estimates. */
export function LogsSettings() {
  useAppLocale();
  const copy = appCopy.settings.logs;
  const config = useLogConfig();
  const viewer = useLogViewer();
  const categories = useSeenCategories(viewer.rows);
  const [storageRevision, setStorageRevision] = useState(0);
  const storage = useLogStorage(storageRevision);
  // A new level can free stores; read their sizes again.
  const level = config.config?.effective.level;
  useEffect(() => setStorageRevision((value) => value + 1), [level]);
  const top = useListTop(viewer.setAtTop);

  const showPending = () => {
    viewer.showPending();
    top.current?.scrollIntoView({ block: "start" });
  };
  const viewerState = viewer.failed ? "error" : viewer.loading && viewer.rows.length === 0 ? "loading"
    : viewer.rows.length === 0 ? "empty" : "ready";
  return (
    <SettingsPage footer={viewer.pending > 0 ? (
      <Presence present motion="rise">
        <Button type="button" size="sm" variant="outline" onClick={showPending} data-test-class="logs-new-lines">
          {copy.newLines(viewer.pending)}
        </Button>
      </Presence>
    ) : undefined}>
      <SettingsSection id="logs-level" kind="form" title={copy.sections.level}
        state={config.config ? "ready" : config.failed ? "error" : "loading"} onRetry={config.reload}>
        <LogLevelFields state={config} categories={categories} />
      </SettingsSection>
      <SettingsSection id="logs-viewer" kind="list" title={copy.sections.viewer} state={viewerState}
        errorMessage={copy.loadFailed} emptyMessage={copy.empty} onRetry={viewer.reload}
        actions={<div ref={top.attach}><LogFilters filter={viewer.filter} categories={categories} live={viewer.live}
          onChange={viewer.setFilter} onLiveChange={viewer.setLive} /></div>}>
        <LogRows viewer={viewer} />
      </SettingsSection>
      <SettingsSection id="logs-storage" kind="status" title={copy.sections.storage}
        state={storage.view ? "ready" : storage.failed ? "error" : "loading"} onRetry={storage.reload}
        actions={<LogStorageActions onCleared={() => { storage.reload(); viewer.reload(); }} />}>
        <LogStoreMeters view={storage.view} />
      </SettingsSection>
      <DeveloperUsageSections />
    </SettingsPage>
  );
}

/** Tracks whether the list's top (its filters) is in view; live rows wait while it is not. */
function useListTop(setAtTop: (atTop: boolean) => void) {
  const node = useRef<HTMLDivElement | null>(null);
  const attach = useCallback((element: HTMLDivElement | null) => {
    node.current = element;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const watcher = new IntersectionObserver(([entry]) => setAtTop(entry?.isIntersecting ?? true));
    watcher.observe(element);
    return () => {
      watcher.disconnect();
      setAtTop(true);
    };
  }, [setAtTop]);
  return { attach, get current() { return node.current; } };
}

/** Every category the viewer has shown this visit, for the filter and the overrides. */
function useSeenCategories(rows: readonly { category: string }[]): string[] {
  const [seen, setSeen] = useState<string[]>([]);
  useEffect(() => {
    setSeen((current) => {
      const next = new Set(current);
      for (const row of rows) next.add(row.category);
      return next.size === current.length ? current : [...next].sort();
    });
  }, [rows]);
  return seen;
}
