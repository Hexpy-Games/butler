// Markdown summary of one React/gpui DS View capture pair (<size>-<theme> directories):
//   bun ds-view-summary.ts --react <dir> --gpui <dir> --diff <dir> --parity-diff <exe>
// Runs parity-diff once over the directories, then prints three tables: per-page pixel counts (story
// crops), the state shots (<page>.<name>.png) and per-story canvas geometry (layout.json, logical px).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = Bun.argv.slice(2);
const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
const [react, gpui, diff, exe] = ["--react", "--gpui", "--diff", "--parity-diff"].map(value);
if (!react || !gpui || !diff || !exe) throw new Error("usage: ds-view-summary.ts --react <dir> --gpui <dir> --diff <dir> --parity-diff <exe>");
const run = Bun.spawnSync([exe, resolve(react), resolve(gpui), resolve(diff)]);
const lines = run.stdout.toString().split("\n").filter(Boolean);
type Result = { size?: string; diff?: number; total?: number; missing?: string };
const results = new Map<string, Result>();
for (const line of lines) {
  const mismatch = /^(\S+) size mismatch \((\d+), (\d+)\) \((\d+), (\d+)\)$/u.exec(line);
  const same = /^(\S+) (\d+)\/(\d+)$/u.exec(line);
  const missing = /^(\S+) missing in ([AB])$/u.exec(line);
  if (mismatch) results.set(mismatch[1], { size: `${mismatch[3]} vs ${mismatch[5]}` });
  else if (same) results.set(same[1], { diff: Number(same[2]), total: Number(same[3]) });
  else if (missing) results.set(missing[1], { missing: missing[2] === "A" ? "react" : "gpui" });
}
const order = (JSON.parse(readFileSync(new URL("./scenes/ds-view.json", import.meta.url), "utf8")).pages as Array<{ page: string }>).map(p => p.page);
const pages = readdirSync(react).filter(f => f.endsWith(".layout.json")).map(f => f.replace(".layout.json", "")).sort((a, b) => order.indexOf(a) - order.indexOf(b));
console.log(`### ${react.split("/").pop()}\n`);
console.log("page | stories | exact-size | size mismatch (React vs gpui height, device px) | differing px / total px (exact-size crops)");
console.log("--- | --- | --- | --- | ---");
for (const page of pages) {
  const crops = [...results].filter(([name]) => new RegExp(`^${page}\\.\\d+\\.png$`, "u").test(name));
  const exact = crops.filter(([, r]) => r.diff !== undefined);
  const mismatched = crops.filter(([, r]) => r.size);
  const missing = crops.filter(([, r]) => r.missing).length;
  const stories = crops.length;
  const d = exact.reduce((n, [, r]) => n + (r.diff ?? 0), 0), t = exact.reduce((n, [, r]) => n + (r.total ?? 0), 0);
  console.log(`${page} | ${stories} | ${exact.length} | ${mismatched.length} ${mismatched.length ? `(${mismatched.map(([, r]) => r.size).join("; ")})` : ""}${missing ? ` +${missing} missing` : ""} | ${d}/${t}`);
}
console.log("\nstate shots\n\nname | size match | differing px / total");
console.log("--- | --- | ---");
for (const [name, r] of [...results].filter(([n]) => /^[^.]+\.[^.]+\.png$/u.test(n) && !/^[^.]+\.\d+\.png$/u.test(n))) {
  console.log(`${name.replace(/\.png$/u, "")} | ${r.diff !== undefined ? "yes" : r.missing ? `missing in ${r.missing}` : `no (${r.size})`} | ${r.diff !== undefined ? `${r.diff}/${r.total}` : "-"}`);
}
console.log("\nstory geometry (logical px, w x h)\n\npage | story | React | gpui");
console.log("--- | --- | --- | ---");
for (const page of pages) {
  const read = (dir: string) => existsSync(join(dir, `${page}.layout.json`)) ? JSON.parse(readFileSync(join(dir, `${page}.layout.json`), "utf8")) as Array<{ anchor: string; w: number; h: number }> : [];
  const [a, b] = [read(react), read(gpui)];
  a.forEach((box) => {
    const other = b.find(candidate => candidate.anchor === box.anchor);
    console.log(`${page} | ${box.anchor} | ${box.w} x ${box.h} | ${other ? `${other.w} x ${other.h}${other.w === box.w && other.h === box.h ? "" : " (differs)"}` : "-"}`);
  });
}
