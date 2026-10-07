/** Playwright's Electron inspector transport needs Node; Bun can still launch the smoke. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export async function nativeSmokeRuntime(entry: string): Promise<number | null> {
  if (!process.versions.bun) return null;
  const temporary = mkdtempSync(join(tmpdir(), "native-smoke-"));
  try {
    symlinkSync(resolve("node_modules"), join(temporary, "node_modules"), "junction");
    const output = join(temporary, "smoke.mjs");
    const build = await Bun.build({ entrypoints: [fileURLToPath(entry)], target: "node", format: "esm", packages: "external", external: ["node:sqlite"] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    await Bun.write(output, build.outputs[0]!);
    const child = spawn("node", [output, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
    const [code] = await once(child, "exit") as [number | null];
    return code ?? 1;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
