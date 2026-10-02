// Test the package managers themselves; missing or broken tools fail this smoke.
import { spawnSync } from "node:child_process";
import { archPackageVersion, debPackageVersion } from "../../packages/butler-app/scripts/release/package-versions.ts";

const versions = ["0.1.0-preview.9", "0.1.0-preview.10", "0.1.0"];
for (const [tool, mapping] of [["dpkg", debPackageVersion], ["vercmp", archPackageVersion]] as const) {
  for (let index = 1; index < versions.length; index++) {
    const left = mapping(versions[index - 1]!);
    const right = mapping(versions[index]!);
    const args = tool === "dpkg" ? ["--compare-versions", left, "lt", right] : [left, right];
    const result = spawnSync(tool, args, { encoding: "utf8" });
    if (result.status !== 0 || (tool === "vercmp" && result.stdout.trim() !== "-1")) {
      throw new Error(`${tool}: expected ${left} < ${right}: ${result.stderr || result.error || result.stdout}`);
    }
    console.log(`${tool}: ${left} < ${right}`);
  }
}
