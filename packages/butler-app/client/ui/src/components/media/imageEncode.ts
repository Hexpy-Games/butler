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
