import { useUpdateProgressStore, updateIsRunning } from "@/stores/updateProgressStore";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyError } from "@/app/notifications.ts";
import type {
  UpdateStatusView,
} from "@/app/types.ts";
import { Button, RefreshCcw } from "@/butler-ds";
import {
  emptyComponentStatus,
  UPDATE_COMPONENTS,
  UpdateComponentRow,
} from "./UpdateComponentRow";
import { useUpdateActions } from "./useUpdateActions";
import { UpdatePreviewSwitch } from "./UpdatePreviewSwitch";
import { SettingsPage, SettingsSection } from "./SettingsFormComponents";

/** The last status read, so reopening the page shows it at once. */
let lastView: UpdateStatusView | null = null;

export function resetUpdatesSettingsCache(): void {
  lastView = null;
}

export function UpdatesSettings() {
  const copy = appCopy.settings;
  const [view, setView] = useState<UpdateStatusView | null>(lastView);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const progress = useUpdateProgressStore((state) => state.progress);
  const applying = updateIsRunning(progress) ? progress!.component : null;

  const reportError = useCallback((error: unknown, action: "check" | "apply") => {
    notifyError(error, action === "check" ? copy.errors.checkUpdates : copy.errors.applyUpdate,
      { id: `settings-updates-${action}` });
  }, [copy.errors.checkUpdates, copy.errors.applyUpdate]);
  const { load, check, apply } = useUpdateActions({ setView, setLoading, setLoadFailed, reportError });

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    lastView = view;
  }, [view]);

  // A status that was never checked fills in by itself once the check runs.
  const unchecked = view?.components.some((item) => item.check_state === "unchecked") ?? false;
  useEffect(() => {
    if (unchecked) void check(true);
  }, [unchecked, check]);

  const rows = useMemo(
    () =>
      UPDATE_COMPONENTS.map((component) =>
        view?.components.find((item) => item.component === component) ??
        emptyComponentStatus(component),
      ),
    [view],
  );

  return (
    <SettingsPage>
      <UpdatePreviewSwitch disabled={loading || applying !== null} onChanged={check} />
      <SettingsSection
        id="updates"
        kind="list"
        state={view ? "ready" : loadFailed ? "error" : "loading"}
        errorMessage={copy.errors.loadUpdates}
        onRetry={() => void load()}
        actions={
          <Button type="button" size="sm" variant="outline" disabled={loading || applying !== null} onClick={() => void check()}>
            <RefreshCcw size="md" /> {loading ? copy.actions.updateChecking : copy.actions.checkUpdates}
          </Button>
        }
      >
        {rows.map((status) => (
          <UpdateComponentRow
            key={status.component}
            status={status}
            applying={applying}
            labels={copy.actions}
            progress={progress?.component === status.component ? progress : null}
            onCancel={() => void api("/updates/cancel", { method: "POST" }).catch((error) => notifyError(error, copy.errors.applyUpdate))}
            onApply={(component) => void apply(component)}
          />
        ))}
      </SettingsSection>
    </SettingsPage>
  );
}
