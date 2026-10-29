import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import type { SettingsView } from "@/app/types";
import { SegmentedControl, SettingsField } from "@/butler-ds";
import { useSettingsUIStore } from "@/stores/settingsUIStore";

export function TextSizeField() {
  useAppLocale();
  const value = useSettingsUIStore((state) => state.draft?.text_size);
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);
  if (!window.butlerApp?.setTextSize || !value) return null;
  const { fields, options } = appCopy.settings;
  return <SettingsField settingId="text-size" label={fields.textSize}
    control={<SegmentedControl ariaLabel={fields.textSize} value={value}
      options={[
        { value: "default", label: options.textSizeDefault },
        { value: "large", label: options.textSizeLarge },
        { value: "larger", label: options.textSizeLarger },
      ]}
      onValueChange={(next) => {
        const text_size = next as SettingsView["text_size"];
        void update({ text_size }, setSettings, { optimistic: { text_size }, silent: true });
      }} />}
  />;
}
