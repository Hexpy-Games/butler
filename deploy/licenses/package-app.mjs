import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { generate } from "./generate.mjs";

// Both renderers read this one asset through their respective static protocols.
export function finalizeAppNotices(appRoot) {
  const macResources = join(appRoot, "Contents/Resources");
  const resources = existsSync(macResources) ? macResources : join(appRoot, "resources");
  const canonical = join(resources, "bundled-agent/resources/app-client/dist/THIRD_PARTY_NOTICES.txt.gz");
  const data = readFileSync(canonical);
  if (gunzipSync(data).toString() !== generate()) throw new Error("Packaged notices are stale");
  for (const file of ["app-client/THIRD_PARTY_NOTICES.txt", "app-client/THIRD_PARTY_NOTICES.txt.gz",
    "bundled-agent/bin/THIRD_PARTY_NOTICES.txt"]) {
    rmSync(join(resources, file), { force: true });
  }
  const pointer = "Human-readable component disclosures: bundled-agent/resources/app-client/dist/THIRD_PARTY_NOTICES.txt.gz\n"
    + "Read with gzip -dc, or Settings > About > Open source licenses.\n";
  writeFileSync(join(resources, "THIRD_PARTY_NOTICES.txt"), pointer);
  console.log(`App disclosures: ${data.length + Buffer.byteLength(pointer)} bytes; one data copy`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  finalizeAppNotices(resolve(process.argv[2]));
}
