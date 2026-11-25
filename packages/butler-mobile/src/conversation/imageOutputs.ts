import type { Access } from "@/connection/access";
import type { GatewayClient } from "../../../butler-protocol/src/client/index.ts";
import { readOutputPage } from "./operationOutput.ts";

export interface ImageAsset {
  id: string; img: string; width: number; height: number; image_url: string;
  parent_id?: string | null; mime?: string;
}
export type ImageFrameAspect = "1:1" | "4:5" | "3:4" | "16:10" | "16:9";

interface OutputImage { schema: "butler.image.v1"; image: string; parent?: string | null }
export function outputImages(value: unknown): { image: string }[] {
  if (typeof value === "string") { try { return outputImages(JSON.parse(value)); } catch { return []; } }
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (record.schema === "butler.image.v1" && typeof record.image === "string") return [record as unknown as OutputImage];
  return Object.values(record).flatMap(outputImages);
}

export function imageAspect(width: number, height: number): ImageFrameAspect {
  const aspects: ImageFrameAspect[] = ["1:1", "4:5", "3:4", "16:10", "16:9"];
  const ratio = width > 0 && height > 0 ? width / height : 1;
  const distance = (aspect: string) => { const [w, h] = aspect.split(":").map(Number); return Math.abs(Math.log(ratio / (w / h))); };
  return aspects.reduce((best, next) => distance(next) < distance(best) ? next : best);
}

const FILL_MIN_RATIO = 0.75;
const FILL_MAX_RATIO = 2.4;
export function frameFit(width: number, height: number): "fill" | "matte" {
  if (!(width > 0 && height > 0)) return "matte";
  const ratio = width / height;
  return ratio >= FILL_MIN_RATIO && ratio <= FILL_MAX_RATIO ? "fill" : "matte";
}

export async function readImageAssets(
  client: GatewayClient, turnId: string, callId: string, resultId: string, signal: AbortSignal,
): Promise<ImageAsset[]> {
  let content = "", offset = 0;
  for (;;) {
    const page = await readOutputPage(client, turnId, callId, resultId, offset, signal);
    content += page.content;
    if (page.complete) break;
    if (page.byte_end <= offset) throw new Error("image_output_incomplete");
    offset = page.byte_end;
  }
  return Promise.all(outputImages(content).map(image =>
    client.request<ImageAsset>(`/message-assets/${encodeURIComponent(image.image)}/meta`, { signal })));
}

export function assetImage(asset: ImageAsset, access: Access, width?: number): { uri: string; headers: Record<string, string> } {
  const w = width === undefined ? "" : `${asset.image_url.includes("?") ? "&" : "?"}w=${Math.max(1, Math.min(1280, Math.ceil(width)))}`;
  const { fileSource } = require("@/outputs/fileAccess") as typeof import("@/outputs/fileAccess");
  return fileSource(access, asset.image_url + w);
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const ZOOM_STEP = 1.5;
export const DOUBLE_TAP_ZOOM = 2;
export type ZoomView = { scale: number; x: number; y: number };
const FIT: ZoomView = { scale: 1, x: 0, y: 0 };

/** Whether a point in the scroll view's frame lies on the zoomed picture. */
export function onPicture(point: { x: number; y: number }, offset: { x: number; y: number }, width: number, height: number, scale: number) {
  const x = point.x + offset.x, y = point.y + offset.y;
  return x >= 0 && y >= 0 && x <= width * scale && y <= height * scale;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function clampView(view: ZoomView, width: number, height: number): ZoomView {
  const scale = clamp(view.scale, MIN_ZOOM, MAX_ZOOM);
  if (scale === 1) return FIT;
  const maxX = ((scale - 1) * width) / 2;
  const maxY = ((scale - 1) * height) / 2;
  return { scale, x: clamp(view.x, -maxX, maxX), y: clamp(view.y, -maxY, maxY) };
}

export function zoomAt(view: ZoomView, scale: number, pointX: number, pointY: number): ZoomView {
  const ratio = scale / view.scale;
  return { scale, x: pointX - (pointX - view.x) * ratio, y: pointY - (pointY - view.y) * ratio };
}
