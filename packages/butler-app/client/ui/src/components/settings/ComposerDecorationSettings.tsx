import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { SegmentedControl, SettingsField } from "@/butler-ds";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import type { SettingsView } from "@/app/types.ts";
import { SettingsSwitch } from "./SettingsFormComponents";

type Setting = SettingsView["composer_decoration"];

export function ComposerDecorationSettings() {
  const locale = useAppLocale();
  const draft = useSettingsUIStore((state) => state.draft);
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);
  if (!draft) return null;
  const setting = draft.composer_decoration;
  const copy = appCopy.settings;
  const save = (patch: Partial<Setting>) => {
    if (Object.entries(patch).some(([key, value]) => setting[key as keyof Setting] !== value)) {
      void update({ composer_decoration: patch }, setSettings);
    }
  };
  return (
    <>
      <SettingsField
        settingId="composer-decoration"
        label={copy.fields.composerDecoration}
        description={copy.descriptions.composerDecoration}
        control={<SegmentedControl ariaLabel={copy.fields.composerDecoration} value={setting.theme}
          options={[
            { value: "none", label: copy.wallpaper.none },
            { value: "shoreline", label: locale === "ko-KR" ? "해안선" : "Shoreline" },
          ]}
          onValueChange={(theme) => save({ theme: theme as Setting["theme"] })} />}
      />
      <SettingsSwitch settingId="composer-character" label={copy.fields.composerCharacter}
        description={copy.descriptions.composerCharacter} checked={setting.character}
        onChange={(character) => save({ character })} />
    </>
  );
}
