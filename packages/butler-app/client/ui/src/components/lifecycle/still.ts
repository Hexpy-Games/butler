/** Asset encoding; the single averaged colour primes the native window before first paint. */
export async function encodeLifecycleStill(blob: Blob) {
  const image = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = 720; canvas.height = 528;
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0, 720, 528);
  image.close();
  const webp = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("still_encode_failed")), "image/webp", 0.9));
  const average = document.createElement("canvas");
  average.width = average.height = 1;
  const sample = average.getContext("2d")!;
  sample.drawImage(canvas, 0, 0, 1, 1);
  const averageColor = `#${Array.from(sample.getImageData(0, 0, 1, 1).data).slice(0, 3).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return { bytes: Array.from(new Uint8Array(await webp.arrayBuffer())), averageColor };
}
