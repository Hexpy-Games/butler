import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const workflow = readFileSync(
  join(root, ".github", "workflows", "windows.yml"),
  "utf8",
);
const entrypoint = readFileSync(
  join(
    root,
    "packages",
    "butler-app",
    "scripts",
    "windows",
    "run-windows-ci.ps1",
  ),
  "utf8",
);
const gitAttributes = readFileSync(join(root, ".gitattributes"), "utf8");
const standardUserRunner = readFileSync(
  join(
    root,
    "packages",
    "butler-app",
    "scripts",
    "windows",
    "run-standard-user-bundled-payload-smoke.ps1",
  ),
  "utf8",
);
const standardUserChild = readFileSync(
  join(
    root,
    "packages",
    "butler-app",
    "scripts",
    "windows",
    "run-bundled-payload-smoke-child.ps1",
  ),
  "utf8",
);
const interactiveController = readFileSync(
  join(
    root,
    "packages",
    "butler-app",
    "scripts",
    "windows",
    "interactive-smoke-controller.ts",
  ),
  "utf8",
);

test("Windows CI uses native runners and PowerShell entrypoints", () => {
  expect(workflow).toContain("runs-on: windows-latest");
  expect(workflow).toContain("shell: pwsh");
  expect(gitAttributes).toContain("* text=auto eol=lf");
  expect(workflow).toContain("bun-version: 1.3.11");
  expect(workflow).toContain("-Mode Setup");
  expect(workflow).toContain("-Mode Quality");
  expect(workflow).toContain("-Mode Tests");
  expect(workflow).toContain("-Mode ProductE2E");
  expect(workflow).toContain("-Mode Package");
  expect(workflow).toContain("-Mode Lifecycle");
  expect(workflow).not.toContain("shell: bash");
  expect(workflow).not.toMatch(/run:\s*(?:bash|sh)\b/u);
  expect(entrypoint).not.toMatch(/\.sh(?:\s|")/u);
  expect(entrypoint).toContain('"Setup"');
  expect(entrypoint).toContain('"--frozen-lockfile"');
  expect(entrypoint).toContain('"--audit-level=high"');
  expect(entrypoint).toContain("build-process-host.ts");
  expect(entrypoint).toContain("BUTLER_WINDOWS_PROCESS_HOST");
  expect(entrypoint).toContain('"--timeout"');
  expect(entrypoint).toContain('"30000"');
  expect(entrypoint).toContain("Invoke-StandardUserSmoke");
  expect(entrypoint).toContain("run-standard-user-bundled-payload-smoke.ps1");
  expect(entrypoint).toMatch(/function Invoke-StandardUserSmoke[\s\S]*?client\/ui[\s\S]*?run[\s\S]*?build/u);
  expect(entrypoint).toContain("-InteractiveDesktop");
});

test("Windows CI proves signed package checksums and keeps distribution gated", () => {
  expect(workflow).toContain("Windows signed package, signatures, and checksums");
  expect(workflow).toContain("Package and verify gated Windows artifacts");
  expect(workflow).toContain("actions/upload-artifact@v4");
  expect(workflow).not.toContain("gh release upload");
  expect(entrypoint).toContain("New-SelfSignedCertificate");
  expect(entrypoint).toContain("Set-AuthenticodeSignature");
  expect(entrypoint).toContain("windows-release-package-smoke.ts");
});

test("nightly Windows CI executes the packaged Squirrel lifecycle", () => {
  expect(workflow).toContain('cron: "17 17 * * *"');
  expect(workflow).toContain("nightly-packaged-e2e:");
  expect(workflow).toContain(
    "Run packaged install, update, rollback, repair, and uninstall E2E",
  );
  expect(entrypoint).toContain("windows-squirrel-release-cycle-smoke.ts");
  expect(entrypoint).toContain("-PrepareRelease");
  expect(standardUserRunner).toContain('$Bun "run" $Smoke "--prepare-only"');
  expect(standardUserRunner).toContain("BUTLER_WINDOWS_CI_ELEVATED_TOKEN = \"1\"");
  expect(standardUserRunner).toContain(
    "BUTLER_WINDOWS_RELEASE_PREPARATION_TOKEN = \"1\"",
  );
  expect(standardUserRunner).toContain("-PreparedReleaseRoot");
  expect(standardUserChild).toContain(
    "BUTLER_WINDOWS_LIFECYCLE_RELEASE_ROOT = $PreparedReleaseRoot",
  );
  expect(standardUserChild).toContain(
    '$env:BUTLER_POWERSHELL = Join-Path $PSHOME "powershell.exe"',
  );
  expect(standardUserRunner).toContain('"-TimeoutMinutes $TimeoutMinutes"');
  expect(standardUserChild).toContain(
    "$deadline = (Get-Date).AddMinutes($TimeoutMinutes)",
  );
  expect(standardUserChild).toContain("--prepared-release-root");
  expect(interactiveController).toContain(
    "BUTLER_WINDOWS_LIFECYCLE_RELEASE_ROOT: preparedReleaseRoot",
  );
});
