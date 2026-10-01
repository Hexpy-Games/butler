// Bundles the shell installer into the package (runs on `npm pack` / `npm publish`).
import { copyFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const source = new URL("../../../deploy/install.sh", import.meta.url);
const target = new URL("../install.sh", import.meta.url);
copyFileSync(source, target);
chmodSync(target, 0o755);
execFileSync(process.execPath, [fileURLToPath(new URL("../../../deploy/licenses/generate.mjs", import.meta.url)),
  fileURLToPath(new URL("../THIRD_PARTY_NOTICES.txt", import.meta.url))], { stdio: "inherit" });
