import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Packaged build metadata is immutable; development without metadata stays on. */
export function readProductFeatures(directory) {
  if (!directory) return { browser: true };
  const file = join(directory, "product-features.json");
  if (!existsSync(file)) return { browser: true };
  const features = JSON.parse(readFileSync(file, "utf8"));
  if (typeof features.browser !== "boolean") throw new Error("invalid_product_features");
  return features;
}
