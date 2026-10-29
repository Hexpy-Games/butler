/** One redraw of a picture into another format. */
async function encode(blob: Blob, type: "image/png" | "image/jpeg"): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (type === "image/jpeg" && context) { context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height); }
  context?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return await new Promise((resolve, reject) => canvas.toBlob((out) => out ? resolve(out) : reject(new Error("image_encode_failed")), type, 0.9));
}

/** The clipboard takes PNG; other formats are redrawn once into a PNG. */
export async function pngBlob(blob: Blob): Promise<Blob> {
  return blob.type === "image/png" ? blob : await encode(blob, "image/png");
}

/** A 서랍 scrap keeps its picture as JPEG; other formats are redrawn once. */
export async function jpegBlob(blob: Blob): Promise<Blob> {
  return blob.type === "image/jpeg" ? blob : await encode(blob, "image/jpeg");
}

/** Paint the mask's transparent region on a preview copy, keeping the input asset untouched. */
export async function maskedPreview(image: string, mask: string, signal: AbortSignal) {
  const blobs = await Promise.all([image, mask].map(async src => {
    const response = await fetch(src, { signal });
    if (!response.ok) throw new Error("image_preview_unavailable");
    return await createImageBitmap(await response.blob());
  }));
  try {
    const canvas = document.createElement("canvas"), layer = document.createElement("canvas");
    canvas.width = layer.width = blobs[0].width; canvas.height = layer.height = blobs[0].height;
    const context = canvas.getContext("2d")!, paint = layer.getContext("2d")!;
    context.drawImage(blobs[0], 0, 0);
    paint.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    paint.globalAlpha = 0.45; paint.fillRect(0, 0, layer.width, layer.height);
    paint.globalCompositeOperation = "destination-out"; paint.drawImage(blobs[1], 0, 0, layer.width, layer.height);
    context.drawImage(layer, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("image_preview_failed"))));
  } finally { blobs.forEach(bitmap => bitmap.close()); }
}
