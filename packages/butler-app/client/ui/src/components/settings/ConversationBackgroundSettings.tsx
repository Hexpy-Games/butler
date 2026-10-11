import { memo } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { uploadedWallpaperSource } from "@/app/wallpaperAssets.ts";
import { FieldError, SettingsField, Stack, WallpaperPicker } from "@/butler-ds";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { ConversationOverlayControl } from "./ConversationOverlayControl";
import { WallpaperImportError } from "./WallpaperImportError";
import { useConversationSourceSave } from "./hooks/useConversationSourceSave";
import { useWallpaperAssets } from "./hooks/useWallpaperAssets";
import { useWallpaperModules } from "./hooks/useWallpaperModules";
import { wallpaperPickerLabels } from "./wallpaperPickerLabels";

const IMAGE_DEFAULTS = { dim: 0 };

export const ConversationBackgroundSettings = memo(function ConversationBackgroundSettings() {
  const locale = useAppLocale();
  const background = useSettingsUIStore((state) => state.draft?.conversation_background);
  const saveSource = useConversationSourceSave();
  const images = useWallpaperAssets("settings-conversation-background-picker");
  const modules = useWallpaperModules();
  if (!background) return null;
  const { source, overlay } = background;
  const showOverlay = source.kind === "image" || (source.kind === "live" && source.module !== "butler.riso-print");
  const upload = async (file: File) => {
    const asset = await images.upload(file);
    if (asset) saveSource({ ...uploadedWallpaperSource(asset), dim: 0 });
  };
  const importModule = async (file: File) => {
    const installed = await modules.importModule(file);
    if (installed) saveSource({ kind: "live", module: installed.id });
  };
  return <SettingsField settingId="conversation-background"
    label={appCopy.settings.fields.conversationBackground}
    control={<Stack gap="sm">
      <WallpaperPicker dataTestClass="settings-conversation-background-picker" locale={locale}
        value={source} labels={{ ...wallpaperPickerLabels(), none: appCopy.settings.fields.conversationPlain }}
        images={images.assets} uploading={images.uploading} imageDefaults={IMAGE_DEFAULTS}
        extraControls={showOverlay ? <ConversationOverlayControl value={overlay} /> : undefined}
        importingModule={modules.importing}
        importError={modules.importError ? <WallpaperImportError message={modules.importError} replace={modules.replaceImport} /> : undefined}
        onChange={(next) => { if (next !== "inherit") saveSource(next); }}
        onUpload={(file) => void upload(file)} onDeleteImage={(id) => void images.remove(id)}
        onImportModule={(file) => void importModule(file)} onDeleteModule={(id) => void modules.deleteModule(id)} />
      {images.uploadError ? <FieldError id={images.uploadErrorId}>{images.uploadError}</FieldError> : null}
    </Stack>} />;
});
