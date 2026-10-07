import { useEffect, useId, useState } from "react";
import { apiErrorCode } from "@/app/api";
import { settingsErrorCopy } from "@/app/settingsErrors";
import { appCopy } from "@/app/copy.ts";
import { notifyStatus } from "@/app/notifications.ts";
import {
  deleteWallpaperAsset,
  listWallpaperAssets,
  uploadWallpaperAsset,
  wallpaperAssetProblem,
  wallpaperUploadProblem,
  type WallpaperAsset,
  type WallpaperAssetProblem,
} from "@/app/wallpaperAssets.ts";

const TOAST_ID = "wallpaper-asset";

/** One brief toast per problem (terse copy, no raw server text). */
function notifyProblem(problem: WallpaperAssetProblem, fallback: "uploadFailed" | "deleteFailed") {
  const copy = appCopy.settings.wallpaper;
  const messages: Record<WallpaperAssetProblem, string> = {
    "unsupported-type": copy.unsupportedType,
    "too-large": copy.tooLarge,
    unreadable: copy.unreadable,
    "in-use": copy.inUse,
    failed: copy[fallback],
  };
  notifyStatus(messages[problem], { id: TOAST_ID, tone: "error" });
}

/**
 * The gateway's wallpaper images for a picker: listed once, oldest first;
 * uploads are checked (type, size) before they leave and appended; deletes
 * drop the image. Upload errors stay under the control; deletion errors use toasts.
 */
export function useWallpaperAssets(pickerClass?: string) {
  const [uploadErrorCode, setUploadErrorCode] = useState<string>();
  const uploadErrorId = useId();
  const uploadError = uploadErrorCode ? settingsErrorCopy({ code: uploadErrorCode }, appCopy.settings.wallpaper.uploadFailed) : undefined;
  const [assets, setAssets] = useState<WallpaperAsset[]>([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!pickerClass) return;
    const button = document.querySelector<HTMLButtonElement>(`[data-test-class~="${pickerClass}"] [data-option="upload"] button`);
    if (!button) return;
    button.setAttribute("aria-invalid", String(Boolean(uploadError)));
    if (uploadError) { button.setAttribute("aria-describedby", uploadErrorId); button.focus(); }
    else button.removeAttribute("aria-describedby");
  }, [pickerClass, uploadError, uploadErrorId]);

  useEffect(() => {
    let live = true;
    listWallpaperAssets().then((list) => {
      if (live) setAssets(list);
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  /** The stored asset, or null with local field feedback. */
  const upload = async (file: File): Promise<WallpaperAsset | null> => {
    setUploadErrorCode(undefined);
    const problem = wallpaperUploadProblem(file);
    if (problem) {
      setUploadErrorCode(problem === "too-large" ? "wallpaper_too_large" : "wallpaper_unsupported_type");
      return null;
    }
    setUploading(true);
    try {
      const asset = await uploadWallpaperAsset(file);
      setAssets((current) => [...current.filter((item) => item.id !== asset.id), asset]);
      return asset;
    } catch (error) {
      setUploadErrorCode(apiErrorCode(error) ?? "unknown");
      return null;
    } finally {
      setUploading(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteWallpaperAsset(id);
      setAssets((current) => current.filter((item) => item.id !== id));
    } catch (error) {
      notifyProblem(wallpaperAssetProblem(error), "deleteFailed");
    }
  };

  return { assets, uploading, upload, remove, uploadError, uploadErrorId };
}
