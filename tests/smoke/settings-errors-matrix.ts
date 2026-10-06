// Each matrix cell owns its stub gateway, browser process, HOME and data dir.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const baseline = process.argv.includes("--baseline");
const evidence: { cell: string; cases: number; rejects: number; measurements: unknown[] }[] = [];
for (const width of [375, 1280]) for (const theme of ["light", "dark"]) for (const locale of ["ko", "en"]) {
  for (const transport of baseline ? ["http"] : ["http", "preload"]) {
    const cell = `${width}-${theme}-${locale}-${transport}`;
    const directory = mkdtempSync(join(tmpdir(), "butler-settings-cell-"));
    for (const child of ["home", "data", "codex"]) mkdirSync(join(directory, child));
    try {
      const child = Bun.spawn([process.execPath, "run", "tests/smoke/settings-errors-smoke.ts", ...(baseline ? ["--baseline"] : [])], {
        env: { ...process.env, SETTINGS_SMOKE_CASE: cell, HOME: join(directory, "home"), BUTLER_DATA: join(directory, "data"), CODEX_HOME: join(directory, "codex") },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      assert.equal(status, 0, `${cell}: ${stderr}`);
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      assert.equal(result.ok, true); assert.equal(result.modelCalls, 0);
      evidence.push({ cell, cases: result.cases, rejects: result.rejects, measurements: result.measurements });
      console.log(`${cell}: ${result.cases} cases passed`);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}
const output = resolve(`.tmp/settings-errors/${baseline ? "before" : "after"}-evidence.json`);
writeFileSync(output, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ ok: true, baseline, cells: evidence.length, cases: evidence.reduce((count, cell) => count + cell.cases, 0), modelCalls: 0, evidence: output }));
