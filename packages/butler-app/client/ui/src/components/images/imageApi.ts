import { api } from "@/app/api";
import { gatewayImageSource } from "@/app/messageFileUrls";
import type { MediaFrameAspect } from "@/butler-ds";

export interface ImageAsset {
  id: string; img: string; width: number; height: number; image_url: string;
  parent_id?: string | null; mime?: string;
}
export interface ImageSelection { model_ref: string; credential_id: string | null; default_quality: string }
export interface ImageModel {
  model_ref: string; display_name: string; provider_id: string; provider_label: string;
  qualities: string[]; default_quality: string;
  credentials: Array<{ id: string; label: string; masked_value: string; selectable: boolean; auth_type: string }>;
}
export interface ImageSettings { selected: ImageSelection | null; models: ImageModel[] }
export const getImageSettings = () => api<ImageSettings>("/settings/image-model");
export const getImageMeta = (id: string, signal?: AbortSignal) => api<ImageAsset>(`/message-assets/${encodeURIComponent(id)}/meta`, { signal });
export const getImageVersions = (id: string, signal?: AbortSignal) => api<ImageAsset[]>(`/message-assets/${encodeURIComponent(id)}/versions`, { signal });
export function assetSource(asset: Pick<ImageAsset, "image_url">, width?: number, download = false): string {
  const src = gatewayImageSource(asset.image_url)!;
  const params = new URLSearchParams();
  if (width) params.set("w", String(Math.max(1, Math.min(1280, Math.ceil(width)))));
  if (download) params.set("download", "1");
  return params.size ? `${src}${src.includes("?") ? "&" : "?"}${params}` : src;
}
export { uploadImageMask } from "@/app/api";
/** Distance in log-ratio treats portrait and landscape deviations symmetrically. */
export function imageAspect(width: number, height: number): MediaFrameAspect {
  const aspects: MediaFrameAspect[] = ["1:1", "4:5", "3:4", "16:10", "16:9"];
  const ratio = width > 0 && height > 0 ? width / height : 1;
  const distance = (aspect: string) => { const [w, h] = aspect.split(":").map(Number); return Math.abs(Math.log(ratio / (w / h))); };
  return aspects.reduce((best, next) => distance(next) < distance(best) ? next : best);
}
