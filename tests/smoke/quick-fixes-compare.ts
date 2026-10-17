// Capture the same product screens using immutable shipped and candidate code.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const baseline = "v0.1.0-preview.8";
const temporary = mkdtempSync(join(tmpdir(), "quick-fixes-before-"));
const output = resolve(".tmp/quick-fixes-comparison");
const capture = resolve("tests/support/quick-fixes-visual.ts");
try {
  const revision = execFileSync("git", ["rev-parse", `${baseline}^{commit}`], { encoding: "utf8" }).trim();
  const archive = join(temporary, "source.tar");
  execFileSync("git", ["archive", revision, "--output", archive]);
  execFileSync("tar", ["-xf", archive, "-C", temporary]);
  rmSync(archive);
  // Each side builds from its own entry and router. The baseline gains only
  // the candidate's fixture; its renderers, styles, copy and behavior stay at
  // the shipped revision. Preview.8's own main.tsx routes ?visual=components to
  // VisualHarness, so that route renders this comparison's fixture.
  const ui = "packages/butler-app/client/ui/src";
  copyFileSync(join(ui, "pages/QuickFixesHarness.tsx"), join(temporary, ui, "pages/QuickFixesHarness.tsx"));
  writeFileSync(join(temporary, ui, "pages/VisualHarness.tsx"),
    'import { QuickFixesHarness } from "./QuickFixesHarness";\n'
    + 'export function VisualHarness() { return <QuickFixesHarness />; }\n');
  execFileSync(process.execPath, ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: temporary, stdio: "inherit" });
  execFileSync("npm", ["--prefix", "packages/butler-app/client/ui", "run", "build"], { cwd: temporary, stdio: "inherit" });
  execFileSync(process.execPath, [capture, join(temporary, "packages/butler-app/client/ui/dist"), join(output, "before"), revision], { stdio: "inherit" });
  const candidate = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync(process.execPath, [capture, resolve("packages/butler-app/client/ui/dist"), join(output, "after"), candidate], { stdio: "inherit" });
} finally { rmSync(temporary, { recursive: true, force: true }); }
