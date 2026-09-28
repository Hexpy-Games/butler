/** Side of the square `u_noiseTexture` (texels). */
export const WALLPAPER_NOISE_SIZE = 256;

const NOISE_SEED = 0x5eed_b17e;

/** 32-bit integer hash (lowbias32): independent, evenly spread bytes per texel and channel. */
function hash(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

let cached: Uint8Array | null = null;

/**
 * Deterministic 256×256 RGBA white noise. Every texel is independent, so the
 * texture tiles seamlessly under REPEAT; modules get smooth noise from it with
 * LINEAR filtering. Built once per page and shared.
 */
export function wallpaperNoiseTexture(): Uint8Array {
  if (cached) return cached;
  const data = new Uint8Array(WALLPAPER_NOISE_SIZE * WALLPAPER_NOISE_SIZE * 4);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = hash(index ^ NOISE_SEED) >>> 24;
  }
  cached = data;
  return data;
}
