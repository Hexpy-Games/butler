import { useId, type ReactNode } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import type { SettingsView as SettingsData } from "@/app/types";
import { uploadedWallpaperSource } from "@/app/wallpaperAssets";
import { SettingsField, Switch, Tooltip, WallpaperPicker } from "@/butler-ds";
import { useWallpaperAssets } from "@/components/settings/hooks/useWallpaperAssets";
import { useWallpaperModules } from "@/components/settings/hooks/useWallpaperModules";
import { useWallpaperSourceSave } from "@/components/settings/hooks/useWallpaperSourceSave";
import { SettingsSwitch } from "@/components/settings/SettingsFormComponents";
import { wallpaperPickerLabels } from "@/components/settings/wallpaperPickerLabels";
import { useSettingsUIStore } from "@/stores/settingsUIStore";
import { t } from "../proposedCopy";
import type { ProposalLocale } from "../state";

// PROPOSAL COPY of components/settings/MainScreenThemeSettings.tsx. Unchanged: picker, then
// Motion, then Pause on battery, same conditions. Changed: while motion is reduced (app switch or
// OS) the wallpaper holds still, so Motion and battery are disabled with a tooltip instead of
// claiming an animation that does not run. `after` renders the new field in variant B.

type Wallpaper = SettingsData["wallpaper"];

function HeldSwitch({ settingId, label, description, reason }: {
  settingId: string; label: string; description: string; reason: string;
}) {
  const id = useId();
  const descriptionId = useId();
  return (
    <SettingsField settingId={settingId} data-test-class="toggle-field settings-switch-row" id={id}
      label={label} description={description} descriptionId={descriptionId}
      control={<Tooltip label={reason}><Switch id={id} aria-describedby={descriptionId} checked={false} disabled /></Tooltip>} />
  );
}

export function HomeScreenFieldsProposal({ locale, reduced, after }: { locale: ProposalLocale; reduced: boolean; after?: ReactNode }) {
  const appLocale = useAppLocale();
  const draft = useSettingsUIStore((state) => state.draft);
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);
  const saveSource = useWallpaperSourceSave();
  const images = useWallpaperAssets();
  const modules = useWallpaperModules();
  const copy = appCopy.settings;
  if (!draft) return null;
  const { source, motion, pauseOnBattery } = draft.wallpaper;
  const save = (wallpaper: Partial<Wallpaper>) => void update({ wallpaper }, setSettings);
  const still = t(locale, "settings.descriptions.wallpaperStill");
  return (
    <>
      <SettingsField
        settingId="main-screen-wallpaper"
        data-test-class="settings-field settings-main-screen-wallpaper"
        label={copy.fields.wallpaper}
        description={copy.descriptions.wallpaper}
        control={
          <WallpaperPicker
            dataTestClass="settings-main-screen-wallpaper-picker"
            images={images.assets}
            importingModule={modules.importing}
            labels={wallpaperPickerLabels()}
            locale={appLocale}
            uploading={images.uploading}
            value={source}
            onChange={(next) => { if (next !== "inherit") saveSource(next); }}
            onDeleteImage={(id) => void images.remove(id)}
            onDeleteModule={(id) => void modules.deleteModule(id)}
            onImportModule={() => undefined}
            onUpload={(file) => void images.upload(file).then((asset) => asset && saveSource(uploadedWallpaperSource(asset)))}
          />
        }
      />
      {source.kind === "none" ? null : reduced ? (
        <HeldSwitch settingId="main-screen-motion" label={copy.fields.wallpaperMotion} description={copy.descriptions.wallpaperMotion} reason={still} />
      ) : (
        <SettingsSwitch settingId="main-screen-motion" label={copy.fields.wallpaperMotion}
          description={copy.descriptions.wallpaperMotion} checked={motion === "auto"}
          onChange={(on) => save({ motion: on ? "auto" : "paused" })} />
      )}
      {source.kind !== "none" && motion === "auto" && !reduced ? (
        <SettingsSwitch settingId="main-screen-battery" label={copy.fields.wallpaperPauseOnBattery}
          description={copy.descriptions.wallpaperPauseOnBattery} checked={pauseOnBattery}
          onChange={(on) => save({ pauseOnBattery: on })} />
      ) : null}
      {after}
    </>
  );
}
