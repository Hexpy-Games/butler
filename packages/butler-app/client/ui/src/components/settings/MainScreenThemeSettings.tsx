import { memo } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { SettingsView as SettingsData } from "@/app/types.ts";
import { uploadedWallpaperSource } from "@/app/wallpaperAssets.ts";
import { FieldError, SettingsField, Stack, WallpaperPicker } from "@/butler-ds";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { useWallpaperAssets } from "./hooks/useWallpaperAssets";
import { WallpaperImportError } from "@/components/settings/WallpaperImportError";
import { useWallpaperModules } from "./hooks/useWallpaperModules";
import { useWallpaperSourceSave } from "./hooks/useWallpaperSourceSave";
import { SettingsSwitch } from "./SettingsFormComponents";
import { useSystemReducedMotion } from "./useSystemReducedMotion";
import { wallpaperPickerLabels } from "./wallpaperPickerLabels";

type Wallpaper = SettingsData["wallpaper"];

/** Settings > Appearance > Home screen: the wallpaper picker, then motion and battery. */
export const MainScreenThemeSettings = memo(function MainScreenThemeSettings() {
  const locale = useAppLocale();
  const system = useSystemReducedMotion();
  const reduced = useButlerStore((state) => state.settings.reduce_motion) || system;
  const decorationTheme = useSettingsUIStore((state) => state.draft?.composer_decoration.theme ?? "none");
  const wallpaper = useSettingsUIStore((state) => state.draft?.wallpaper);
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);
  const saveSource = useWallpaperSourceSave();
  const images = useWallpaperAssets("settings-main-screen-wallpaper-picker");
  const modules = useWallpaperModules();
  const copy = appCopy.settings;

  if (!wallpaper) return null;

  const { source, motion, pauseOnBattery } = wallpaper;
  const save = (wallpaper: Partial<Wallpaper>) => void update({ wallpaper }, setSettings);
  const upload = async (file: File) => {
    const asset = await images.upload(file);
    if (asset) saveSource(uploadedWallpaperSource(asset));
  };
  const importModule = async (file: File) => {
    const installed = await modules.importModule(file);
    if (installed) saveSource({ kind: "live", module: installed.id });
  };

  return (
    <>
      <SettingsField
        settingId="main-screen-wallpaper"
        data-test-class="settings-field settings-main-screen-wallpaper"
        label={copy.fields.wallpaper}
        description={copy.descriptions.wallpaper}
        control={
          <Stack gap="sm"><WallpaperPicker
            dataTestClass="settings-main-screen-wallpaper-picker"
            images={images.assets}
            importingModule={modules.importing}
            importError={modules.importError ? <WallpaperImportError message={modules.importError} replace={modules.replaceImport} /> : undefined}
            labels={wallpaperPickerLabels()}
            locale={locale}
            uploading={images.uploading}
            value={source}
            onChange={(next) => {
              if (next !== "inherit") saveSource(next);
            }}
            onDeleteImage={(id) => void images.remove(id)}
            onDeleteModule={(id) => void modules.deleteModule(id)}
            onImportModule={(file) => void importModule(file)}
            onUpload={(file) => void upload(file)}
          />
          {images.uploadError ? <FieldError id={images.uploadErrorId}>{images.uploadError}</FieldError> : null}
          </Stack>
        }
      />
      {source.kind === "none" && decorationTheme === "none" ? null : (
        <SettingsSwitch
          settingId="main-screen-motion"
          label={copy.fields.wallpaperMotion}
          description={copy.descriptions.wallpaperMotion}
          checked={!reduced && motion === "auto"}
          disabledReason={reduced ? copy.descriptions.wallpaperStill : undefined}
          onChange={(on) => save({ motion: on ? "auto" : "paused" })}
        />
      )}
      {(source.kind !== "none" || decorationTheme !== "none") && motion === "auto" && !reduced ? (
        <SettingsSwitch
          settingId="main-screen-battery"
          label={copy.fields.wallpaperPauseOnBattery}
          description={copy.descriptions.wallpaperPauseOnBattery}
          checked={pauseOnBattery}
          onChange={(on) => save({ pauseOnBattery: on })}
        />
      ) : null}
    </>
  );
});
