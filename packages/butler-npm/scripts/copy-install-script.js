// Bundles the shell installer into the package (runs on `npm pack` / `npm publish`).
import { copyFileSync, chmodSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const source = new URL("../../../deploy/install.sh", import.meta.url);
const target = new URL("../install.sh", import.meta.url);
copyFileSync(source, target);
chmodSync(target, 0o755);
copyFileSync(new URL("../../../deploy/install.ps1", import.meta.url), new URL("../install.ps1", import.meta.url));
execFileSync(process.execPath, [fileURLToPath(new URL("../../../deploy/licenses/generate.mjs", import.meta.url)),
  fileURLToPath(new URL("../THIRD_PARTY_NOTICES.txt.gz", import.meta.url))], { stdio: "inherit" });

writeFileSync(new URL("../THIRD_PARTY_NOTICES.txt", import.meta.url), "Complete human-readable notices: THIRD_PARTY_NOTICES.txt.gz\nRead with: gzip -dc THIRD_PARTY_NOTICES.txt.gz\n");
