import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { SettingsPage, SettingsSection } from "./SettingsFormComponents";
import { ButlerModelFields } from "./ButlerModelFields";
import { PermissionsFields } from "./PermissionsFields";
import { ModelAddEditPage } from "./ModelAddEditPage";
import { ModelManagementPage } from "./ModelManagementPage";

/** The everyday Models page; backup, cleanup and worker models live under Advanced. */
export function ModelsSettings() {
  useAppLocale();
  const draft = useSettingsUIStore((state) => state.draft);
  const modelRoute = useSettingsUIStore((state) => state.modelRoute);

  if (!draft) return null;

  if (modelRoute.page === "management") return <ModelManagementPage />;
  if (modelRoute.page === "add") return <ModelAddEditPage />;
  if (modelRoute.page === "edit") {
    return <ModelAddEditPage modelRef={modelRoute.modelRef} />;
  }

  const sections = appCopy.settings.pageSections;
  return (
    <SettingsPage>
      <SettingsSection id="butler-model" kind="form" title={sections.butlerModel}>
        <ButlerModelFields />
      </SettingsSection>
      <SettingsSection id="permissions" kind="form" title={sections.permissions}>
        <PermissionsFields />
      </SettingsSection>
    </SettingsPage>
  );
}
