import { useState } from "react";
import { settingsErrorCopy } from "@/app/settingsErrors";
import { apiErrorCode } from "@/app/api";
import { appCopy } from "@/app/copy.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { userWallpaperModules } from "@/app/userWallpaperModules.ts";
import {
  WALLPAPER_MODULE_IMPORT_MAX_BYTES,
  deleteWallpaperModule,
  importWallpaperModule,
  wallpaperModuleInUse,
  type WallpaperModuleListing,
} from "@/app/wallpaperModules.ts";

const TOAST_ID = "wallpaper-module";

/** Installs user modules; import validation stays next to the picker. */
export function useWallpaperModules() {
  const [conflictingFile, setConflictingFile] = useState<File>();
  const [importErrorCode, setImportErrorCode] = useState<string>();
  const [importing, setImporting] = useState(false);
  const copy = appCopy.settings.wallpaper;

  const importModule = async (file: File, replace = false): Promise<WallpaperModuleListing | null> => {
    setImportErrorCode(undefined);
    setConflictingFile(undefined);
    if (file.size > WALLPAPER_MODULE_IMPORT_MAX_BYTES) {
      setImportErrorCode("wallpaper_module_archive_too_large");
      return null;
    }
    setImporting(true);
    try {
      const installed = await importWallpaperModule(file, { replace });
      await userWallpaperModules.refresh([installed.id]);
      return installed;
    } catch (error) {
      setImportErrorCode(apiErrorCode(error) ?? "unknown");
      if (!replace && apiErrorCode(error) === "wallpaper_module_exists") setConflictingFile(file);
      return null;
    } finally {
      setImporting(false);
    }
  };

  const deleteModule = async (id: string): Promise<void> => {
    try {
      await deleteWallpaperModule(id);
      await userWallpaperModules.refresh([id]);
    } catch (error) {
      notifyStatus(wallpaperModuleInUse(error) ? copy.moduleInUse : copy.moduleDeleteFailed, { id: TOAST_ID, tone: "error" });
    }
  };

  return { importing, importModule, deleteModule,
    replaceImport: conflictingFile ? () => void importModule(conflictingFile, true) : undefined,
    importError: importErrorCode ? settingsErrorCopy({ code: importErrorCode }, copy.moduleImportFailed) : undefined,
  };
}
