import { useEffect, useState } from "react";
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
 * drop the image. Failures become brief toasts.
 */
export function useWallpaperAssets() {
  const [assets, setAssets] = useState<WallpaperAsset[]>([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    let live = true;
    listWallpaperAssets().then((list) => {
      if (live) setAssets(list);
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  /** The stored asset, or null after a toast. */
  const upload = async (file: File): Promise<WallpaperAsset | null> => {
    const problem = wallpaperUploadProblem(file);
    if (problem) {
      notifyProblem(problem, "uploadFailed");
      return null;
    }
    setUploading(true);
    try {
      const asset = await uploadWallpaperAsset(file);
      setAssets((current) => [...current.filter((item) => item.id !== asset.id), asset]);
      return asset;
    } catch (error) {
      notifyProblem(wallpaperAssetProblem(error), "uploadFailed");
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

  return { assets, uploading, upload, remove };
}
