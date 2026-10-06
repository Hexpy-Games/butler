/** Playwright's Electron inspector transport needs Node; Bun can still launch the smoke. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function nativeSmokeRuntime(entry: string): Promise<number | null> {
  if (!process.versions.bun) return null;
  mkdirSync(resolve(".tmp"), { recursive: true });
  const temporary = mkdtempSync(join(resolve(".tmp"), "native-smoke-"));
  try {
    const output = join(temporary, "smoke.mjs");
    const build = await Bun.build({ entrypoints: [fileURLToPath(entry)], target: "node", format: "esm", packages: "external" });
    if (!build.success) throw new Error(build.logs.join("\n"));
    await Bun.write(output, build.outputs[0]!);
    const child = spawn("node", [output, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
    const [code] = await once(child, "exit") as [number | null];
    return code ?? 1;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
