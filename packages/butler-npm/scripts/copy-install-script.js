// Bundles the shell installer into the package (runs on `npm pack` / `npm publish`).
import { copyFileSync, chmodSync } from "node:fs";

const source = new URL("../../../deploy/install.sh", import.meta.url);
const target = new URL("../install.sh", import.meta.url);
copyFileSync(source, target);
chmodSync(target, 0o755);
