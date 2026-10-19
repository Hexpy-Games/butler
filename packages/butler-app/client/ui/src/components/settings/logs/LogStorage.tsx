import { useEffect, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { confirmAction } from "@/app/confirmation.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { Button, ButtonContainer, ProgressMeter } from "@/butler-ds";
import { formatBytes } from "./logFormat";
import { LogExportDialog } from "./LogExportDialog";
import { clearLogs, readLogStorage, type LogStorageView, type LogStoreUsage } from "./logsApi";

export interface LogStorageState {
  view: LogStorageView | null;
  failed: boolean;
  reload: () => void;
}

/** GET /logs/storage, read again whenever `revision` changes. */
export function useLogStorage(revision: number): LogStorageState {
  const [view, setView] = useState<LogStorageView | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    readLogStorage().then((next) => { if (!cancelled) setView(next); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [attempt, revision]);
  return { view, failed, reload: () => setAttempt((value) => value + 1) };
}

type StoreKind = keyof typeof appCopy.settings.logs.stores;
const STORE_ORDER: readonly StoreKind[] = ["app", "main", "debug", "bodies"];

/** How full a store is, 0–1. */
function fill(store: LogStoreUsage): number {
  return store.limit_bytes > 0 ? store.bytes / store.limit_bytes : 0;
}

/**
 * 앱 and 에이전트 are each source's main store (`app/main`, `agent/main`).
 * 자세히 and 본문 have a limit per source (`debug`, `bodies`); each meter
 * shows whichever source's store is fuller, with that store's own limit.
 */
function storeGroups(stores: readonly LogStoreUsage[]): Array<LogStoreUsage & { id: StoreKind }> {
  const groups = new Map<StoreKind, LogStoreUsage & { id: StoreKind }>();
  for (const store of stores) {
    const [source, name] = store.id.split("/");
    const kind: StoreKind | null = name === "main" ? (source === "app" ? "app" : "main")
      : name === "debug" || name === "bodies" ? name : null;
    if (!kind) continue;
    const current = groups.get(kind);
    if (!current || fill(store) > fill(current)) groups.set(kind, { ...store, id: kind });
  }
  return STORE_ORDER.flatMap((kind) => groups.get(kind) ?? []);
}

/** 저장 공간's meters: 앱, 에이전트, 자세히, 본문, with use, limit and retention. */
export function LogStoreMeters({ view }: { view: LogStorageView | null }) {
  return <>{storeGroups(view?.stores ?? []).map((store) => <StoreMeter key={store.id} store={store} />)}</>;
}

function StoreMeter({ store }: { store: LogStoreUsage & { id: StoreKind } }) {
  const copy = appCopy.settings.logs;
  const label = copy.stores[store.id];
  // A week or more reads in days (14일); shorter windows in hours (72시간).
  const retention = store.retention_h >= 168 && store.retention_h % 24 === 0
    ? copy.retentionDays(store.retention_h / 24) : copy.retentionHours(store.retention_h);
  const value = Math.min(100, fill(store) * 100);
  return (
    <ProgressMeter label={label} value={value} tone={value >= 90 ? "warning" : "default"}
      meta={copy.storeMeta(formatBytes(store.bytes), formatBytes(store.limit_bytes), retention)} />
  );
}

/** 내보내기… and 모두 삭제… in the section header. */
export function LogStorageActions({ onCleared }: { onCleared: () => void }) {
  const copy = appCopy.settings.logs;
  const [exporting, setExporting] = useState(false);
  const [clearing, setClearing] = useState(false);

  async function clearAll() {
    if (!await confirmAction(copy.clearBody, { title: copy.clearTitle, confirmLabel: appCopy.common.delete, destructive: true })) return;
    setClearing(true);
    try {
      const { agent_freed_bytes: freed } = await clearLogs();
      notifyStatus(copy.cleared(formatBytes(freed)), { id: "logs-clear", tone: "ok" });
      onCleared();
    } catch (error) {
      notifyError(error, copy.clearFailed, { id: "logs-clear" });
    } finally {
      setClearing(false);
    }
  }

  return (
    <ButtonContainer size="sm">
      <Button type="button" size="sm" variant="outline" onClick={() => setExporting(true)}>{copy.exportMenu}</Button>
      <Button type="button" size="sm" variant="outline" disabled={clearing} onClick={() => void clearAll()}>{copy.clearMenu}</Button>
      {exporting ? <LogExportDialog onClose={() => setExporting(false)} /> : null}
    </ButtonContainer>
  );
}
