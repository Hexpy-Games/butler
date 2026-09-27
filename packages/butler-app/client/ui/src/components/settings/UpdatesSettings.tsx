import { useAppLocale } from "@/app/copy.ts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyError } from "@/app/notifications.ts";
import type {
  UpdateApplyResult,
  UpdateComponentId,
  UpdateStatusView,
} from "@/app/types.ts";
import { Button, RefreshCcw } from "@/butler-ds";
import {
  emptyComponentStatus,
  UPDATE_COMPONENTS,
  UpdateComponentRow,
} from "./UpdateComponentRow";
import { SettingsPage, SettingsSection } from "./SettingsFormComponents";

export function UpdatesSettings() {
  useAppLocale();
  const copy = appCopy.settings;
  const [view, setView] = useState<UpdateStatusView | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [applying, setApplying] = useState<UpdateComponentId | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      setView(await api<UpdateStatusView>("/updates"));
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [copy.errors.loadUpdates]);

  const check = useCallback(async () => {
    setLoading(true);
    try {
      setView(await api<UpdateStatusView>("/updates/check", {
        method: "POST",
        body: JSON.stringify({ component: "app" }),
      }));
    } catch (error) {
      notifyError(error, copy.errors.checkUpdates, { id: "settings-updates-check" });
    } finally {
      setLoading(false);
    }
  }, [copy.errors.checkUpdates]);

  const apply = useCallback(async (component: UpdateComponentId) => {
    setApplying(component);
    try {
      const result = await api<UpdateApplyResult>("/updates/apply", {
        method: "POST",
        body: JSON.stringify({ component }),
      });
      setView((previous) => mergeUpdateResult(previous, result));
    } catch (error) {
      notifyError(error, copy.errors.applyUpdate, { id: "settings-updates-apply" });
    } finally {
      setApplying(null);
    }
  }, [copy.errors.applyUpdate]);

  useEffect(() => {
    void load();
  }, [load]);

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
      <SettingsSection
        id="updates"
        kind="list"
        state={view ? "ready" : loadFailed ? "error" : "loading"}
        errorMessage={copy.errors.loadUpdates}
        onRetry={() => void load()}
        actions={
          <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void check()}>
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
            onApply={(component) => void apply(component)}
          />
        ))}
      </SettingsSection>
    </SettingsPage>
  );
}

function mergeUpdateResult(
  view: UpdateStatusView | null,
  result: UpdateApplyResult,
): UpdateStatusView {
  const generatedAt = result.checked_at;
  const components = view?.components ?? UPDATE_COMPONENTS.map(emptyComponentStatus);
  return {
    generated_at: generatedAt,
    components: components.map((component) =>
      component.component === result.component ? result : component,
    ),
    storage_label: "updates",
    manifest_source: result.manifest_source,
    raw_text_included: false,
  };
}
