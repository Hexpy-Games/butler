import { ListGroup } from "@/ds";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useAppLocale } from "@/i18n";
import { SettingsScreen, LoadState } from "@/settings/layout";
import { SwitchRow } from "@/settings/rows";
import { useSettings } from "@/settings/useSettings";

export default function AppearanceSettings() {
  const S = getAppCopy(useAppLocale()).settings;
  const { settings, error, reload, update } = useSettings();
  return <SettingsScreen title={S.sections.appearance} description={S.sectionDescriptions.appearance}>
    {!settings ? <ListGroup><LoadState error={error} onRetry={reload} /></ListGroup> : <ListGroup label={S.pageSections.conversation}>
      <SwitchRow title={S.fields.showThinking} value={settings.show_thinking} onChange={show_thinking => { void update({ show_thinking }); }} />
    </ListGroup>}
  </SettingsScreen>;
}
