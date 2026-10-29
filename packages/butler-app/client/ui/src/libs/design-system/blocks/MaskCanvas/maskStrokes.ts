/** One brush or eraser stroke in the picture's own pixels. */
export interface MaskStroke {
  tool: "brush" | "eraser";
  /** Diameter in picture pixels. */
  size: number;
  points: Array<[number, number]>;
}

/** Draws a segment of a stroke (or a dot for its first point) onto the paint layer. */
export function drawSegment(context: CanvasRenderingContext2D, stroke: MaskStroke, from: number, paint: string) {
  const { points } = stroke;
  context.save();
  context.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
  context.strokeStyle = paint;
  context.fillStyle = paint;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = stroke.size;
  if (points.length === 1 || from === 0) {
    const [x, y] = points[0];
    context.beginPath();
    context.arc(x, y, stroke.size / 2, 0, Math.PI * 2);
    context.fill();
  }
  if (points.length > 1) {
    context.beginPath();
    const [startX, startY] = points[Math.max(0, from - 1)];
    context.moveTo(startX, startY);
    for (let index = Math.max(1, from); index < points.length; index += 1) context.lineTo(points[index][0], points[index][1]);
    context.stroke();
  }
  context.restore();
}

/** Repaints every stroke (after undo or clear). */
export function redraw(context: CanvasRenderingContext2D, strokes: readonly MaskStroke[], paint: string) {
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  for (const stroke of strokes) drawSegment(context, stroke, 0, paint);
}

/**
 * The edit mask at the picture's size: opaque everywhere except the painted
 * region, which is transparent (alpha 0 = edit, soft at the brush edges).
 */
export function maskBlob(paintLayer: HTMLCanvasElement): Promise<Blob | null> {
  const mask = document.createElement("canvas");
  mask.width = paintLayer.width;
  mask.height = paintLayer.height;
  const context = mask.getContext("2d");
  if (!context) return Promise.resolve(null);
  context.fillStyle = "#000";
  context.fillRect(0, 0, mask.width, mask.height);
  context.globalCompositeOperation = "destination-out";
  context.drawImage(paintLayer, 0, 0);
  return new Promise((resolve) => mask.toBlob(resolve, "image/png"));
}

/** True when nothing is painted (every alpha is 0); reads the layer once. */
export function isBlank(paintLayer: HTMLCanvasElement): boolean {
  const context = paintLayer.getContext("2d");
  if (!context) return true;
  const { data } = context.getImageData(0, 0, paintLayer.width, paintLayer.height);
  for (let index = 3; index < data.length; index += 4) if (data[index] !== 0) return false;
  return true;
}
