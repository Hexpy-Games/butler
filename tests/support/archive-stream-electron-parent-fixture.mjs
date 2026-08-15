import { readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const positional = process.argv[2]?.endsWith("archive-stream-electron-parent-app")
  ? process.argv.slice(3)
  : process.argv.slice(2);
const [worker, archivePath, runtimeHome, inventoryPath] = positional;
const bun = process.env.BUTLER_BUN;
if (!bun || !worker || !archivePath || !runtimeHome || !inventoryPath) {
  console.log(JSON.stringify({ schema: "butler.archive-stream-guard.v1", ok: false, hasLauncher: false }));
  process.exit(2);
} else {
  rmSync(runtimeHome, { recursive: true, force: true });
  rmSync(inventoryPath, { force: true });
  const result = spawnSync(bun, [worker, archivePath, runtimeHome, inventoryPath], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  let hasLauncher = false;
  if (result.status === 0) {
    try {
      hasLauncher = JSON.parse(readFileSync(inventoryPath, "utf8")).hasLauncher === true;
    } catch {
      hasLauncher = false;
    }
  }
  console.log(JSON.stringify({
    schema: "butler.archive-stream-guard.v1",
    ok: result.status === 0 && hasLauncher,
    hasLauncher,
  }));
  process.exit(result.status === 0 && hasLauncher ? 0 : 1);
}
