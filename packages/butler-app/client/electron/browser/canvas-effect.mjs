// A drag on a canvas should add marks along its own path. When earlier marks
// outside that path disappear instead, the drag edited or moved something that
// already existed (often the selected object). Pixels decide; nothing here knows
// the page. The result is a neutral note the model can act on.
const WIDTH = 480, MARGIN = 10, SETTLE_MS = 150;

function viewportRect(tab, rect) {
  const bounds = tab.view.getBounds();
  const x = Math.max(0, Math.floor(rect?.x ?? 0)), y = Math.max(0, Math.floor(rect?.y ?? 0));
  const right = Math.min(bounds.width, Math.ceil((rect?.x ?? 0) + (rect?.width ?? bounds.width)));
  const bottom = Math.min(bounds.height, Math.ceil((rect?.y ?? 0) + (rect?.height ?? bounds.height)));
  return right - x >= 8 && bottom - y >= 8 ? { x, y, width: right - x, height: bottom - y } : null;
}

async function capture(tab, rect) {
  const image = await tab.view.webContents.capturePage(rect, { stayHidden: true }).catch(() => null);
  return image && !image.isEmpty() ? image : null;
}

/** Captures the canvas before a drag that starts on it. */
export async function canvasBefore(tab, target) {
  if (target.hit?.role !== "canvas" || !target.destination) return null;
  const rect = viewportRect(tab, target.rect);
  const image = rect && await capture(tab, rect);
  return image ? { rect, image } : null;
}

// The most common colour is the canvas background.
function background(pixels) {
  const counts = new Map();
  for (let index = 0; index < pixels.length; index += 16) {
    const key = (pixels[index] >> 4) << 8 | (pixels[index + 1] >> 4) << 4 | pixels[index + 2] >> 4;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const [key] = [...counts].reduce((best, entry) => entry[1] > best[1] ? entry : best);
  return [((key >> 8) & 15) * 16 + 8, ((key >> 4) & 15) * 16 + 8, (key & 15) * 16 + 8];
}

function pathBox(target, rect, scale) {
  const points = [target, ...(target.path ?? []), target.destination];
  const xs = points.map(point => (point.x - rect.x) * scale), ys = points.map(point => (point.y - rect.y) * scale);
  return { left: Math.min(...xs) - MARGIN, right: Math.max(...xs) + MARGIN, top: Math.min(...ys) - MARGIN, bottom: Math.max(...ys) + MARGIN };
}

/** Counts marks that vanished outside the drag's own box, after the drag. */
export async function canvasEffect(tab, before, target) {
  await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
  const after = await capture(tab, before.rect);
  if (!after) return null;
  const scale = Math.min(1, WIDTH / before.rect.width);
  const size = { width: Math.max(1, Math.round(before.rect.width * scale)), height: Math.max(1, Math.round(before.rect.height * scale)) };
  const a = before.image.resize(size).toBitmap(), b = after.resize(size).toBitmap();
  if (a.length !== b.length) return null;
  const bg = background(a), box = pathBox(target, before.rect, scale);
  // Channel order does not matter: the background is read in the bitmap's own order.
  const distance = (pixels, index) => Math.abs(pixels[index] - bg[0]) + Math.abs(pixels[index + 1] - bg[1]) + Math.abs(pixels[index + 2] - bg[2]);
  let removed = 0, added = 0;
  for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
    const index = (y * size.width + x) * 4, inside = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    if (!inside && distance(a, index) > 120 && distance(b, index) < 45) removed++;
    if (inside && distance(a, index) < 45 && distance(b, index) > 120) added++;
  }
  if (removed < Math.max(12, size.width * size.height / 4000)) return null;
  return { removed_marks: removed, added_marks: added,
    note: `this drag made earlier marks outside its own path disappear or move (${removed} sampled pixels), so it likely edited or moved an existing object (for example the selected one) instead of drawing a new one. Check the screenshot; if that was not intended, undo, deselect (Escape or a click on empty canvas), select the drawing tool again, and redraw.` };
}
