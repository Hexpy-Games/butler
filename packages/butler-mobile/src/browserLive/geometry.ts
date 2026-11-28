type Size = { width: number; height: number };
type Point = { x: number; y: number };
type Box = Size & Point;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
/** The page viewport for a stage, in whole CSS px within what the gateway accepts. The page lays out
 * at exactly what the phone shows, so a soft keyboard shortens it and the frame stays at full size. */
export function pageViewport(previous: Size, stage: Size): Size {
  const width = clamp(Math.round(stage.width), 200, 1280);
  const height = clamp(Math.round(stage.height), 200, 2000);
  return width === previous.width && height === previous.height ? previous : { width, height };
}

export function fit(stage: Size, frame: Size): Box {
  const scale = Math.min(stage.width / frame.width, stage.height / frame.height);
  const width = frame.width * scale;
  const height = frame.height * scale;
  return { x: (stage.width - width) / 2, y: (stage.height - height) / 2, width, height };
}

export function toFrame(point: Point, box: Box): Point | null {
  if (box.width <= 0 || box.height <= 0) return null;
  const x = (point.x - box.x) / box.width;
  const y = (point.y - box.y) / box.height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}
