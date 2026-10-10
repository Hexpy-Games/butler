//! Bitmap work on a Butler-owned page that web content never reaches: marks
//! are drawn on the captured bitmap (never in the page DOM), JPEGs are fitted
//! to the carrier limit, thumbnails and stills are scaled (the App executor
//! uses an offscreen window and `nativeImage` for the same steps).
use super::page::Page;
use serde_json::{Value, json};

const HELPERS: &str = r"(() => { if (globalThis.butlerImage) return true;
const load = async src => { const image = new Image(); image.src = src; await image.decode(); return image; };
const canvasOf = (width, height) => { const c = document.createElement('canvas'); c.width = width; c.height = height; return c; };
const bytes = url => { const data = url.slice(url.indexOf(',') + 1); return Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0); };
const fit = (source, max) => {
  for (const side of [max, Math.round(max * 0.75)]) {
    const scale = Math.min(1, side / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale)), height = Math.max(1, Math.round(source.height * scale));
    const c = canvasOf(width, height), x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(source, 0, 0, width, height);
    for (const quality of [75, 60, 45, 30]) {
      const url = c.toDataURL('image/jpeg', quality / 100);
      if (bytes(url) <= 150 * 1024) return { data: url.slice(url.indexOf(',') + 1), width, height };
    }
  }
  return null;
};
globalThis.butlerImage = {
  async compose(src, marks, viewport, max) {
    const image = await load(src);
    const c = canvasOf(image.naturalWidth, image.naturalHeight), context = c.getContext('2d');
    context.drawImage(image, 0, 0);
    const sx = c.width / viewport.width, sy = c.height / viewport.height;
    const labelScale = Math.max(1, Math.max(c.width, c.height) / 1024);
    context.font = (12 * labelScale) + 'px monospace';
    for (const mark of marks) {
      const x = mark.rect.x * sx, y = mark.rect.y * sy, width = mark.rect.width * sx, height = mark.rect.height * sy;
      if (mark.secure) { context.fillStyle = '#000'; context.fillRect(x, y, width, height); continue; }
      context.strokeStyle = '#222'; context.lineWidth = 2 * labelScale; context.strokeRect(x, y, width, height);
      const w = context.measureText(mark.ref).width + 6 * labelScale, h = 16 * labelScale, top = Math.max(0, y - h);
      if (width < w || height < h) continue;
      context.fillStyle = '#fff'; context.fillRect(x, top, w, h); context.fillStyle = '#000'; context.fillText(mark.ref, x + 3 * labelScale, top + 12 * labelScale);
    }
    return fit(c, max);
  },
  async fit(src, max) { const image = await load(src); return fit(image, max); },
  async thumb(src) {
    const image = await load(src), c = canvasOf(160, 100), x = c.getContext('2d');
    x.drawImage(image, 0, 0, 160, 100);
    const data = x.getImageData(0, 0, 160, 100).data; let text = '';
    for (let i = 0; i < data.length; i += 8192) text += String.fromCharCode(...data.subarray(i, i + 8192));
    return btoa(text);
  },
  async still(src) {
    const image = await load(src), height = Math.max(1, Math.round(image.naturalHeight * 320 / image.naturalWidth));
    const c = canvasOf(320, height); c.getContext('2d').drawImage(image, 0, 0, 320, height);
    const url = c.toDataURL('image/jpeg', 0.7);
    return bytes(url) <= 24 * 1024 ? url.slice(url.indexOf(',') + 1) : null;
  },
  async effect(beforeSrc, afterSrc, rect, points) {
    const scale = Math.min(1, 480 / rect.width), width = Math.max(1, Math.round(rect.width * scale)), height = Math.max(1, Math.round(rect.height * scale));
    const pixels = async src => { const image = await load(src), c = canvasOf(width, height), x = c.getContext('2d'); x.drawImage(image, 0, 0, width, height); return x.getImageData(0, 0, width, height).data; };
    const a = await pixels(beforeSrc), b = await pixels(afterSrc);
    const counts = new Map();
    for (let i = 0; i < a.length; i += 16) { const key = (a[i] >> 4) << 8 | (a[i + 1] >> 4) << 4 | a[i + 2] >> 4; counts.set(key, (counts.get(key) ?? 0) + 1); }
    const [key] = [...counts].reduce((best, entry) => entry[1] > best[1] ? entry : best);
    const bg = [((key >> 8) & 15) * 16 + 8, ((key >> 4) & 15) * 16 + 8, (key & 15) * 16 + 8];
    const xs = points.map(p => (p.x - rect.x) * scale), ys = points.map(p => (p.y - rect.y) * scale);
    const box = { left: Math.min(...xs) - 10, right: Math.max(...xs) + 10, top: Math.min(...ys) - 10, bottom: Math.max(...ys) + 10 };
    const distance = (p, i) => Math.abs(p[i] - bg[0]) + Math.abs(p[i + 1] - bg[1]) + Math.abs(p[i + 2] - bg[2]);
    let removed = 0, added = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4, inside = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
      if (!inside && distance(a, i) > 120 && distance(b, i) < 45) removed++;
      if (inside && distance(a, i) < 45 && distance(b, i) > 120) added++;
    }
    return removed < Math.max(12, width * height / 4000) ? null : { removed_marks: removed, added_marks: added };
  },
};
return true; })()";

/// Calls `butlerImage.<method>(...args)` on the utility page.
pub(crate) async fn call(page: &Page, method: &str, args: &[Value]) -> Option<Value> {
    let session = super::targets::utility(&page.cdp, &page.shared)
        .await
        .ok()?;
    let ready = page
        .send_to(
            &session,
            "Runtime.evaluate",
            json!({"expression":HELPERS,"returnByValue":true}),
        )
        .await
        .ok()?;
    if ready["result"]["value"] != true {
        return None;
    }
    let arguments: Vec<String> = args.iter().map(Value::to_string).collect();
    let expression = format!("butlerImage.{method}({})", arguments.join(","));
    let mut result = page
        .send_to(
            &session,
            "Runtime.evaluate",
            json!({"expression":expression,"returnByValue":true,"awaitPromise":true}),
        )
        .await
        .ok()?;
    if result.get("exceptionDetails").is_some() {
        return None;
    }
    let value = result["result"]["value"].take();
    (!value.is_null()).then_some(value)
}

pub(crate) fn png(data: &str) -> Value {
    json!(format!("data:image/png;base64,{data}"))
}

pub(crate) fn jpeg(data: &str) -> Value {
    json!(format!("data:image/jpeg;base64,{data}"))
}
