import { useEffect, type RefObject } from "react";
import type { WallpaperEngine } from "./engine";
import type { WallpaperContentRect } from "./types";
import type { WallpaperProps } from "./wallpaperProps";

type Rect = WallpaperContentRect | undefined;

/** A rect as primitive deps: a new but equal rect object never reaches the engine. */
function rectKey(rect: Rect): string {
  return rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : "";
}

function parse(key: string): WallpaperContentRect | null {
  if (!key) return null;
  const [x = 0, y = 0, width = 0, height = 0] = key.split(",").map(Number);
  return { x, y, width, height };
}

/**
 * Hands the wallpaper's live inputs to its engine: motion, the keep-outs (by value) and drift events (a new
 * event id fires once).
 */
export function useWallpaperEngineInputs(
  engineRef: RefObject<WallpaperEngine | null>,
  { motion = "auto", pauseOnBattery = false, contentRect, contentRect2, columnRect, event }: WallpaperProps,
) {
  useEffect(() => {
    engineRef.current?.setMotion(motion, pauseOnBattery);
  }, [engineRef, motion, pauseOnBattery]);

  const content = rectKey(contentRect);
  useEffect(() => {
    engineRef.current?.setContentRect(parse(content));
  }, [engineRef, content]);

  const composer = rectKey(contentRect2);
  useEffect(() => {
    engineRef.current?.setContentRect2(parse(composer));
  }, [engineRef, composer]);

  const column = rectKey(columnRect);
  useEffect(() => {
    engineRef.current?.setColumnRect(parse(column));
  }, [engineRef, column]);

  const eventId = event?.id;
  const eventKind = event?.kind;
  useEffect(() => {
    if (eventId !== undefined && eventKind) engineRef.current?.event(eventKind);
  }, [engineRef, eventId, eventKind]);
}
