import { appCopy } from "@/app/copy.ts";
import { nativeShortcutModifier } from "@/app/nativeNotifications.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import type { SettingsView as SettingsData } from "@/app/types.ts";
import { SettingsSelect, SettingsSwitch } from "./SettingsFormComponents";

/** Existing input controls, in their original order; plan mode is the last field. */
export function ConversationInputFields() {
  const draft = useSettingsUIStore(state => state.draft);
  const update = useSettingsUIStore(state => state.update);
  const setSettings = useButlerStore(state => state.setSettings);
  const fields = appCopy.settings.fields;
  const options = appCopy.settings.options;
  if (!draft) return null;
  return <>
        <SettingsSelect
          settingId="follow-up-behavior"
          label={fields.followUpBehavior}
          value={draft.follow_up_behavior}
          onChange={(value) =>
            update({ follow_up_behavior: value as SettingsData["follow_up_behavior"] }, setSettings)}
          options={[
            { value: "queue", label: options.queueWhileBusy },
            { value: "steer", label: options.steerCurrentTurn },
          ]}
        />
        <SettingsSelect
          settingId="multiline-send"
          label={fields.multilineSend}
          value={draft.multiline_send_behavior}
          onChange={(value) =>
            update({ multiline_send_behavior: value as SettingsData["multiline_send_behavior"] }, setSettings)}
          options={[
            { value: "modifier_enter_send_enter_newline", label: options.modifierEnterSendEnterNewline(nativeShortcutModifier()) },
            { value: "enter_send_shift_enter_newline", label: options.enterSendShiftEnterNewline },
          ]}
        />
      <SettingsSwitch
        settingId="plan-mode-default"
        label={fields.planModeDefault}
        checked={draft.plan_mode_default}
        onChange={(value) => update({ plan_mode_default: value }, setSettings)}
      />
  </>;
}
