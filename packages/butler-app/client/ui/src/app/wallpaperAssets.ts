// Wallpaper image assets on the gateway (`/wallpapers`): list, upload, delete,
// and the authenticated byte loader the wallpaper engine draws from. The
// desktop app goes through the preload bridge (it adds the local bearer
// token); the browser build uses same-origin fetch.
import { wallpaperImageDefaultDim, type WallpaperImageLoader, type WallpaperImageVariant, type WallpaperSource } from "@/butler-ds";
import {
  unwrapWallpaperBridge as unwrap,
  wallpaperBridgeMethod as bridgeMethod,
  wallpaperGatewayRequest as request,
  wallpaperResponseError,
} from "./wallpaperGateway.ts";

/** A stored wallpaper image (gateway `AppWallpaperAsset`). */
export interface WallpaperAsset {
  /** `wp_` + 32 hex digits. */
  id: string;
  width: number;
  height: number;
  /** Average relative luminance of the visible pixels, 0 (black) to 1 (white). */
  luminance: number;
  /** Average color, `#rrggbb`. */
  color: string;
  /** Size of the stored (re-encoded) image. */
  bytes: number;
  createdAt: string;
}

export const WALLPAPER_UPLOAD_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp"];
/** The gateway's input limit (plan decision 6). */
export const WALLPAPER_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** What a failed wallpaper request tells the user (one brief toast each). */
export type WallpaperAssetProblem = "unsupported-type" | "too-large" | "unreadable" | "in-use" | "failed";

const CODE_PROBLEMS: Record<string, WallpaperAssetProblem> = {
  wallpaper_unsupported_type: "unsupported-type",
  wallpaper_too_large: "too-large",
  wallpaper_image_invalid: "unreadable",
  wallpaper_dimensions_unsupported: "unreadable",
  wallpaper_in_use: "in-use",
};
const STATUS_PROBLEMS: Record<number, WallpaperAssetProblem> = { 409: "in-use", 413: "too-large", 415: "unsupported-type" };

/** A file the gateway would reject by type or size; null when it may go (no type: the gateway sniffs the bytes). */
export function wallpaperUploadProblem(file: { type: string; size: number }): WallpaperAssetProblem | null {
  if (file.type && !WALLPAPER_UPLOAD_TYPES.includes(file.type)) return "unsupported-type";
  return file.size > WALLPAPER_UPLOAD_MAX_BYTES ? "too-large" : null;
}

export function wallpaperAssetProblem(error: unknown): WallpaperAssetProblem {
  const { code, status } = (error && typeof error === "object" ? error : {}) as { code?: unknown; status?: unknown };
  if (typeof code === "string" && CODE_PROBLEMS[code]) return CODE_PROBLEMS[code];
  return (typeof status === "number" && STATUS_PROBLEMS[status]) || "failed";
}

/** The source a fresh upload is selected as: fill the screen, dimmed for its luminance (`wallpaperImageDefaultDim`). */
export function uploadedWallpaperSource(asset: Pick<WallpaperAsset, "id" | "luminance">): Extract<WallpaperSource, { kind: "image" }> {
  return { kind: "image", asset: asset.id, fit: "cover", dim: wallpaperImageDefaultDim(asset.luminance), blur: 0 };
}

/** Stored images, oldest first (a new upload lands next to the upload tile). */
export async function listWallpaperAssets(): Promise<WallpaperAsset[]> {
  const data = await request<{ wallpapers?: WallpaperAsset[] }>("listWallpapers", undefined, "/wallpapers");
  return [...(data?.wallpapers ?? [])].reverse();
}

export async function uploadWallpaperAsset(file: File): Promise<WallpaperAsset> {
  if (bridgeMethod("uploadWallpaper")) {
    const input = { name: file.name, mimeType: file.type, bytes: await file.arrayBuffer() };
    return await request<WallpaperAsset>("uploadWallpaper", input, "/wallpapers");
  }
  const form = new FormData();
  form.set("file", file, file.name);
  return await request<WallpaperAsset>("uploadWallpaper", undefined, "/wallpapers", { method: "POST", body: form });
}

/** Rejects with `wallpaper_in_use` (409) while a setting or project references the image. */
export async function deleteWallpaperAsset(id: string): Promise<void> {
  await request("deleteWallpaper", { id }, `/wallpapers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** The engine's image loader: an asset's stored bytes, or its thumbnail. */
export const loadWallpaperAssetImage: WallpaperImageLoader = async (id: string, variant: WallpaperImageVariant) => {
  const method = bridgeMethod("readWallpaperImage");
  if (method) {
    const { bytes, mimeType } = unwrap<{ bytes: ArrayBuffer; mimeType?: string }>(await method({ id, variant }));
    return new Blob([bytes], { type: mimeType ?? "" });
  }
  const response = await fetch(`/wallpapers/${encodeURIComponent(id)}${variant === "thumbnail" ? "/thumbnail" : ""}`);
  if (!response.ok) throw await wallpaperResponseError(response);
  return await response.blob();
};
