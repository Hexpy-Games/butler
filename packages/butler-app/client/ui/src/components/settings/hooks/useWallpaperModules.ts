import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { userWallpaperModules } from "@/app/userWallpaperModules.ts";
import {
  WALLPAPER_MODULE_IMPORT_MAX_BYTES,
  deleteWallpaperModule,
  importWallpaperModule,
  wallpaperModuleExists,
  wallpaperModuleInUse,
  type WallpaperModuleListing,
} from "@/app/wallpaperModules.ts";

const TOAST_ID = "wallpaper-module";

/** The first non-empty line of the gateway's message, trimmed for a toast; empty without one. */
function firstLine(message: string): string {
  return message.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "";
}

/**
 * Installs and removes the user's own wallpaper modules for a picker: the
 * module store refreshes after either so the registry catches up. Import
 * failures show the gateway's own message (imports fail for many specific
 * reasons — traversal, symlinks, an invalid manifest, a name already taken),
 * except an installed id, whose toast offers to replace it; delete failures
 * are brief, canned toasts (an in-use conflict is common enough to word on
 * its own).
 */
export function useWallpaperModules() {
  const [importing, setImporting] = useState(false);
  const copy = appCopy.settings.wallpaper;

  const importModule = async (file: File, replace = false): Promise<WallpaperModuleListing | null> => {
    if (file.size > WALLPAPER_MODULE_IMPORT_MAX_BYTES) {
      notifyStatus(copy.moduleTooLarge, { id: TOAST_ID, tone: "error" });
      return null;
    }
    setImporting(true);
    try {
      const installed = await importWallpaperModule(file, { replace });
      await userWallpaperModules.refresh([installed.id]);
      return installed;
    } catch (error) {
      if (!replace && wallpaperModuleExists(error)) {
        notifyStatus(copy.moduleExists, {
          id: TOAST_ID,
          tone: "error",
          action: { label: copy.replaceModule, onClick: () => void importModule(file, true) },
        });
        return null;
      }
      const message = error instanceof Error ? firstLine(error.message) : "";
      notifyStatus(message || copy.moduleImportFailed, { id: TOAST_ID, tone: "error" });
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

  return { importing, importModule, deleteModule };
}
