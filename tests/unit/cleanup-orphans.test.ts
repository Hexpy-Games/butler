import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const cleanupScript = join(root, "packages", "butler-agent", "scripts", "cleanup-orphans.sh");

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body, { encoding: "utf8", mode: 0o755 });
}

test("cleanup-orphans only targets processes for the current Butler data root", () => {
  const tmp = mkdtempSync(join(tmpdir(), "butler-orphan-scope-"));
  const bin = join(tmp, "bin");
  const currentData = join(tmp, ".butler-current");
  const otherData = join(tmp, ".butler-other");
  const home = join(tmp, "repo-home");
  mkdirSync(bin, { recursive: true });
  mkdirSync(currentData, { recursive: true });
  mkdirSync(otherData, { recursive: true });
  mkdirSync(home, { recursive: true });

  writeExecutable(
    join(bin, "ps"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [ \"${1:-}\" = \"aux\" ]; then",
      "  printf '%s\\n' 'user 111 0.0 0.0 0 0 ?? S 10:00AM 0:00.00 /fake/bun run /shared/butler/packages/butler-agent/src/gateways/app/cli.ts --data /Users/example/.butler'",
      `  printf '%s\\n' 'user 222 0.0 0.0 0 0 ?? S 10:00AM 0:00.00 /fake/bun run ${currentData}/app/runtime/agent/versions/0.0.8/packages/butler-agent/src/gateways/app/cli.ts --data ${currentData}'`,
      "  exit 0",
      "fi",
      "if [ \"${1:-}\" = \"-o\" ] && [ \"${2:-}\" = \"etime=\" ]; then",
      "  printf '%s\\n' '10:00'",
      "  exit 0",
      "fi",
      "if [ \"${1:-}\" = \"-o\" ] && [ \"${2:-}\" = \"command=\" ]; then",
      "  pid=\"${4:-}\"",
      "  case \"$pid\" in",
      "    111) printf '%s\\n' '/fake/bun run /shared/butler/packages/butler-agent/src/gateways/app/cli.ts --data /Users/example/.butler' ;;",
      `    222) printf '%s\\n' '/fake/bun run ${currentData}/app/runtime/agent/versions/0.0.8/packages/butler-agent/src/gateways/app/cli.ts --data ${currentData}' ;;`,
      "    *) printf '\\n' ;;",
      "  esac",
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );

  const result = spawnSync("bash", [cleanupScript], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      BUTLER_CLEANUP_ALLOW_HOME_SCOPE: "0",
      BUTLER_DATA: currentData,
      BUTLER_HOME: home,
      CLEANUP_ORPHANS_DRY_RUN: "1",
      MIN_AGE_SECONDS: "0",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Skipping PID=111");
  expect(result.stdout).toContain("outside current Butler data root");
  expect(result.stdout).toContain("Killing orphan Butler runtime process: PID=222");
  expect(result.stdout).toContain("Cleaned up 1 orphan process");
  expect(result.stdout).not.toContain("Killing orphan Butler runtime process: PID=111");
});
