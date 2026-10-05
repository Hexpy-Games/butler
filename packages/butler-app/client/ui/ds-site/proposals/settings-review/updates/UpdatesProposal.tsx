import { appCopy, useAppLocale } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import { Button, RefreshCcw } from "@/butler-ds";
import { SettingsPage, SettingsSection } from "@/components/settings/SettingsFormComponents";
import { UPDATE_COMPONENTS } from "@/components/settings/UpdateComponentRow";
import { UpdatePreviewSwitch } from "@/components/settings/UpdatePreviewSwitch";
import { t } from "../proposedCopy";
import type { StageState } from "../state";
import { CodexUpdateRow } from "./CodexUpdateRow";
import { AGENT_STATUS, APP_STATUS } from "./updateFixture";
import { UpdateRowProposal } from "./UpdateRowProposal";

// Composition of components/settings/UpdatesSettings.tsx, unchanged: the real preview switch
// section, then the "updates" list section with its header check button and one row per
// component. Only the rows are the proposal (or the codex replica, for comparison).

export function UpdatesProposal({ state, patch }: { state: StageState; patch: (next: Partial<StageState>) => void }) {
  useAppLocale();
  const copy = appCopy.settings;
  const running = !["available", "failed", "upToDate", "ready", "deferred"].includes(state.update);
  const onAction = (action: "update" | "cancel" | "restart" | "retry") => {
    if (action === "cancel") {
      notifyStatus(t(state.locale, "settings.updateProgress.cancelled"), { id: "app-update" });
      patch({ update: "available" });
      return;
    }
    patch({ update: action === "restart" ? "activating" : "checking" });
  };
  return (
    <SettingsPage>
      <UpdatePreviewSwitch disabled={running} onChanged={async () => undefined} />
      <SettingsSection
        id="updates"
        kind="list"
        actions={
          <Button type="button" size="sm" variant="outline" disabled={running}>
            <RefreshCcw size="md" /> {copy.actions.checkUpdates}
          </Button>
        }
      >
        {/* main lists UPDATE_COMPONENTS = ["app"] only; the agent ships inside the app. */}
        {UPDATE_COMPONENTS.map((id) => (id === "app" ? APP_STATUS : AGENT_STATUS)).map((status) => state.updateVariant === "codex" ? (
          <CodexUpdateRow key={status.component} status={status} stage={state.update} failure={state.failure} locale={state.locale} />
        ) : (
          <UpdateRowProposal key={status.component} status={status} stage={state.update}
            failure={state.failure} locale={state.locale} onAction={onAction} />
        ))}
      </SettingsSection>
    </SettingsPage>
  );
}
