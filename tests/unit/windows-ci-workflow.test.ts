import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const workflow = readFileSync(
  join(root, ".github", "workflows", "windows.yml"),
  "utf8",
);
const distributionWorkflow = readFileSync(
  join(root, ".github", "workflows", "windows-distribution.yml"),
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

test("Windows pull-request CI only builds and verifies the package", () => {
  expect(workflow).toContain("pull_request:");
  expect(workflow).toContain("runs-on: windows-latest");
  expect(workflow).toContain("shell: pwsh");
  expect(gitAttributes).toContain("* text=auto eol=lf");
  expect(workflow).toContain("bun-version: 1.3.11");
  expect(workflow).toContain("-Mode Setup");
  expect(workflow).toContain("-Mode Package");
  expect(workflow).not.toContain("-Mode Quality");
  expect(workflow).not.toContain("-Mode Tests");
  expect(workflow).not.toContain("-Mode ProductE2E");
  expect(workflow).not.toContain("-Mode Lifecycle");
  expect(workflow).not.toContain("schedule:");
  expect(workflow).not.toContain("workflow_dispatch:");
  expect(workflow).not.toContain("push:");
  expect(workflow.match(/runs-on: windows-latest/gu)).toHaveLength(1);
  expect(workflow).not.toContain("shell: bash");
  expect(workflow).not.toMatch(/run:\s*(?:bash|sh)\b/u);
  expect(entrypoint).not.toMatch(/\.sh(?:\s|")/u);
  expect(entrypoint).toContain('"Setup"');
  expect(entrypoint).toContain('"--frozen-lockfile"');
  expect(entrypoint).toContain('"--audit-level=high"');
  expect(entrypoint).toContain("build-process-host.ts");
  expect(entrypoint).toContain("BUTLER_WINDOWS_PROCESS_HOST");
  expect(entrypoint).toContain('$Mode -notin @("Setup", "Package")');
  expect(entrypoint).toContain(
    "Hosted Windows CI owns package construction only",
  );
});

test("Windows CI proves package structure and checksums without distribution", () => {
  expect(workflow).toContain("Windows package build");
  expect(workflow).toContain("Build and verify Windows package artifacts");
  expect(workflow).toContain("actions/upload-artifact@v4");
  expect(workflow).not.toContain("gh release upload");
  expect(entrypoint).toContain("New-SelfSignedCertificate");
  expect(entrypoint).toContain("Set-AuthenticodeSignature");
  expect(entrypoint).toContain("windows-release-package-smoke.ts");
});

test("Windows distribution is a separate manually dispatched action", () => {
  expect(distributionWorkflow).toContain("workflow_dispatch:");
  expect(distributionWorkflow).toContain("tag:");
  expect(distributionWorkflow).toContain("contents: write");
  expect(distributionWorkflow).toContain("WINDOWS_CERTIFICATE_PFX");
  expect(distributionWorkflow).toContain("WINDOWS_CERTIFICATE_PASSWORD");
  expect(distributionWorkflow).toContain(
    "BUTLER_APP_REQUIRE_PRODUCTION_SIGNING",
  );
  expect(distributionWorkflow).toContain(
    "releases/download/$env:WINDOWS_RELEASE_TAG",
  );
  expect(distributionWorkflow).toContain("windows-app-release-manifest.json");
  expect(distributionWorkflow).toContain("windows-app-update-manifest.json");
  expect(distributionWorkflow).toContain("gh release upload");
  expect(distributionWorkflow).not.toContain("pull_request:");
  expect(distributionWorkflow).not.toContain("-Mode ProductE2E");
  expect(distributionWorkflow).not.toContain("-Mode Lifecycle");
});

test("packaged desktop lifecycle remains physical-interactive only", () => {
  expect(workflow).not.toContain("InteractiveDesktop");
  expect(workflow).not.toContain("standard-user");
  expect(entrypoint).toContain("windows-squirrel-release-cycle-smoke.ts");
  expect(entrypoint).toContain("-PrepareRelease");
  expect(standardUserRunner).toContain('$Bun "run" $Smoke "--prepare-only"');
  expect(standardUserRunner).toContain(
    'BUTLER_WINDOWS_CI_ELEVATED_TOKEN = "1"',
  );
  expect(standardUserRunner).toContain(
    'BUTLER_WINDOWS_RELEASE_PREPARATION_TOKEN = "1"',
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
  expect(standardUserRunner).toContain("-LogonType Interactive");
  expect(standardUserChild).toContain("& explorer.exe $shortcutPath");
});
