/** Per-step visual check for canvas pointer steps: a hit test proves the surface,
 * not the paint. Compare the pixels around the stroke before and after dispatch. */
const PAD = 6;

function region(target, scale) {
  const points = [target, ...(target.path ?? []), ...(target.destination ? [target.destination] : [])];
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const x = Math.max(0, Math.floor((Math.min(...xs) - PAD) * scale)), y = Math.max(0, Math.floor((Math.min(...ys) - PAD) * scale));
  return { x, y, width: Math.ceil((Math.max(...xs) + PAD) * scale) - x, height: Math.ceil((Math.max(...ys) + PAD) * scale) - y };
}

export function canvasStep(step, target) {
  return Boolean(step.point) && ["click", "drag"].includes(step.action) && target.hit?.role === "canvas";
}

export async function pixelsBefore(tab, target) {
  const rect = region(target, tab.bounds?.scale ?? 1);
  const image = await tab.view.webContents.capturePage(rect, { stayHidden: true }).catch(() => null);
  return image && !image.isEmpty() ? { rect, image } : null;
}

/** Changed pixels (any channel differing by more than 24) inside the step's bounding box. */
export async function pixelChange(tab, before) {
  if (!before) return undefined;
  await tab.view.webContents.executeJavaScript("new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true))))").catch(() => {});
  const after = await tab.view.webContents.capturePage(before.rect, { stayHidden: true }).catch(() => null);
  if (!after || after.isEmpty()) return undefined;
  const a = before.image.toBitmap(), b = after.toBitmap();
  if (a.length !== b.length) return undefined;
  let changed = 0;
  for (let n = 0; n < a.length; n += 4) {
    if (Math.abs(a[n] - b[n]) > 24 || Math.abs(a[n + 1] - b[n + 1]) > 24 || Math.abs(a[n + 2] - b[n + 2]) > 24) changed++;
  }
  return changed;
}
