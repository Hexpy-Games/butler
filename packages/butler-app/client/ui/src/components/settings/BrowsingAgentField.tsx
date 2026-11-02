import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { useSettingsUIStore } from "@/stores/settingsUIStore";
import { SettingsSection, SettingsSelect } from "./SettingsFormComponents";

/** Uses the same registered model list and server resolution as Settings. */
export function BrowsingAgentField() {
  useAppLocale();
  const settings = useButlerStore((state) => state.settings);
  const catalog = useButlerStore((state) => state.modelCatalog);
  const setSettings = useButlerStore((state) => state.setSettings);
  const update = useSettingsUIStore((state) => state.update);
  const saving = useSettingsUIStore((state) => state.saving);
  const copy = appCopy.settings.browsingAgent;
  const models = (catalog.registered_models ?? []).filter((model) => model.runtime_supported && model.enabled !== false);
  const auto = settings.browser?.auto;
  const autoModel = models.find((model) => model.model_ref === auto?.model)
    ?? catalog.models.find((model) => model.model_ref === auto?.model);
  const autoName = auto?.available ? (autoModel?.display_name ?? copy.conversationModel) : copy.conversationModel;
  return <SettingsSection id="browsing-agent" kind="form" title={appCopy.settings.pageSections.browsing}>
    <SettingsSelect settingId="browsing-agent" label={copy.label}
      value={settings.browser?.browsing_agent ?? "off"} disabled={saving}
      onChange={(value) => void update({ browser: { browsing_agent: value } }, setSettings)}
      options={[
        { value: "auto", label: copy.auto(autoName) },
        { value: "off", label: copy.off },
        ...models.map((model) => ({ value: model.model_ref, label: model.display_name })),
      ]} />
  </SettingsSection>;
}
