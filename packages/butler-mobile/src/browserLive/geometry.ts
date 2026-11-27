type Size = { width: number; height: number };
type Point = { x: number; y: number };
type Box = Size & Point;

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
