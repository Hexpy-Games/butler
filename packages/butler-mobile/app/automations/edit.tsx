import { Platform } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { AutomationFormSections } from "@/automations/AutomationFormSections";
import { useAutomationForm } from "@/automations/useAutomationForm";
import { IconButton, icons, ListGroup, showToast } from "@/ds";
import { useAppLocale } from "@/i18n";
import { LoadState, SettingsScreen } from "@/settings/layout";

export default function EditAutomation() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const app = getAppCopy(useAppLocale()), copy = app.automations;
  const { draft, set, error, loadError, load, saving, save } = useAutomationForm(id);
  const saveSchedule = async () => {
    const automation = await save();
    if (!automation) return;
    if (id) router.back();
    else router.replace({ pathname: "/automations/[id]", params: { id: automation.id, title: automation.title } });
    showToast({ message: copy.saved, tone: "success" });
  };
  const disabled = !draft || saving;
  return <SettingsScreen title={id ? copy.title : copy.new} options={Platform.OS === "ios" ? {
    unstable_headerRightItems: () => [{ type: "button", label: app.common.save, disabled,
      icon: { type: "sfSymbol", name: "checkmark" }, onPress: saveSchedule }],
  } : { headerRight: () => <IconButton icon={icons.CheckIcon} variant="ghost" label={app.common.save}
    disabled={disabled} onPress={saveSchedule} /> }}>
    {draft ? <AutomationFormSections draft={draft} set={set} error={error} />
      : <ListGroup><LoadState error={loadError} onRetry={load} /></ListGroup>}
  </SettingsScreen>;
}
