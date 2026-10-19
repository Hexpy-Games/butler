import { nativeImage } from "electron";

/** Electron desktop N32 bitmaps are premultiplied BGRA; ImageData is straight RGBA. */
export function bitmapRgba(image) {
  const bytes = image.toBitmap();
  for (let n = 0; n < bytes.length; n += 4) {
    const b = bytes[n], a = bytes[n + 3];
    bytes[n] = a ? Math.round(bytes[n + 2] * 255 / a) : 0;
    bytes[n + 1] = a ? Math.round(bytes[n + 1] * 255 / a) : 0;
    bytes[n + 2] = a ? Math.round(b * 255 / a) : 0;
  }
  return bytes;
}

export function imageFromRgba(pixels, size) {
  const bytes = Buffer.from(pixels);
  for (let n = 0; n < bytes.length; n += 4) {
    const r = bytes[n], a = bytes[n + 3] / 255;
    bytes[n] = Math.round(bytes[n + 2] * a);
    bytes[n + 1] = Math.round(bytes[n + 1] * a);
    bytes[n + 2] = Math.round(r * a);
  }
  return nativeImage.createFromBitmap(bytes, size);
}
