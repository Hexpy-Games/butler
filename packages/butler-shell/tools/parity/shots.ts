import { closeSync, mkdtempSync, openSync, readSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnTrackedProcess } from "../../../../tests/support/native-app-server.ts";

export async function shots(binary: string, out: string, name: string, data: string, scale: number, size: string, dark: boolean, chat?: string, anchors: string[] = []) {
  const log = join(out, "logs", `${name}-shots.log`);
  const writer = openSync(log, "w"), reader = openSync(log, "r");
  const lines: string[] = [];
  let offset = 0, partial = "";
  const drain = () => {
    const buffer = Buffer.alloc(64 * 1024);
    let count: number;
    while ((count = readSync(reader, buffer, 0, buffer.length, offset)) > 0) {
      offset += count;
      const parts = (partial + buffer.subarray(0, count).toString()).split("\n");
      partial = parts.pop()!;
      lines.push(...parts);
    }
  };
  const watcher = watch(log, drain);
  const home = mkdtempSync(join(tmpdir(), "butler-parity-shots-"));
  const process = spawnTrackedProcess(binary, [join(out, "gpui"), "--data", data, "--scale", String(scale), "--size", size, ...(dark ? ["--dark"] : [])], { stdio: ["pipe", writer, writer], cleanupPaths: [home], env: { ...globalThis.process.env, HOME: home, BUTLER_DATA: data, BUTLER_E2E_TIER: "stub" } });
  closeSync(writer);
  writeFileSync(join(out, "logs", `${name}-shots.pid`), String(process.pid));
  let error: Error | undefined;
  process.child.on("error", cause => { error = cause; });
  async function expect(expected: string) {
    const deadline = Date.now() + 60_000;
    for (;;) {
      drain();
      const line = lines.shift();
      if (line === expected) return;
      if (error) throw error;
      if (process.child.exitCode !== null || process.child.signalCode !== null) throw new Error(`shots exited before ${expected}: ${log}`);
      if (Date.now() >= deadline) throw new Error(`shots deadline waiting for ${expected}: ${log}`);
      await Bun.sleep(25);
    }
  }
  try {
    await expect("LIVE READY");
    const showDrawer = Number(size.split("x")[0]) <= 640 ? ["click sidebar-toggle"] : [];
    for (const command of ["connected", chat ? `open ${chat}` : "new", "stable", ...showDrawer, "drag sidebar-toggle -10000", `shot ${name}`, `layout ${name} ${anchors.join(" ")}`]) {
      process.child.stdin!.write(`${command}\n`);
      await expect("LIVE OK");
    }
    process.child.stdin!.end("quit\n");
  } finally {
    await process.stop();
    watcher.close();
    closeSync(reader);
  }
}
