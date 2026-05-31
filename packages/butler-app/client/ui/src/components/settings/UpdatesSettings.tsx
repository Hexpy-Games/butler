import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import type {
  UpdateApplyResult,
  UpdateComponentId,
  UpdateStatusView,
} from "@/app/types.ts";
import { Button, RefreshCcw, Stack } from "@/butler-ds";
import {
  emptyComponentStatus,
  UPDATE_COMPONENTS,
  UpdateComponentRow,
} from "./UpdateComponentRow";
import { SettingsSection } from "./SettingsSection";

export function UpdatesSettings() {
  const copy = appCopy.settings;
  const [view, setView] = useState<UpdateStatusView | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState<UpdateComponentId | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setView(await api<UpdateStatusView>("/updates"));
    } finally {
      setLoading(false);
    }
  }, []);

  const check = useCallback(async () => {
    setLoading(true);
    try {
      setView(await api<UpdateStatusView>("/updates/check", {
        method: "POST",
        body: JSON.stringify({}),
      }));
    } finally {
      setLoading(false);
    }
  }, []);

  const apply = useCallback(async (component: UpdateComponentId) => {
    setApplying(component);
    try {
      const result = await api<UpdateApplyResult>("/updates/apply", {
        method: "POST",
        body: JSON.stringify({ component }),
      });
      setView((previous) => mergeUpdateResult(previous, result));
    } finally {
      setApplying(null);
    }
  }, []);

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
    <SettingsSection
      title={copy.panels.updates}
      description={copy.descriptions.updates}
    >
      <Stack gap="md">
        <Stack align="row" justify="end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => void check()}
          >
            <RefreshCcw size={15} /> {loading ? copy.actions.updateChecking : copy.actions.checkUpdates}
          </Button>
        </Stack>
        <Stack gap="sm">
          {rows.map((status) => (
            <UpdateComponentRow
              key={status.component}
              status={status}
              applying={applying}
              labels={copy.actions}
              onApply={(component) => void apply(component)}
            />
          ))}
        </Stack>
      </Stack>
    </SettingsSection>
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
