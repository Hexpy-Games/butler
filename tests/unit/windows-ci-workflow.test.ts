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

test("Windows CI uses native runners and PowerShell entrypoints", () => {
  expect(workflow).toContain("runs-on: windows-latest");
  expect(workflow).toContain("shell: pwsh");
  expect(workflow).toContain("-Mode Quality");
  expect(workflow).toContain("-Mode Tests");
  expect(workflow).toContain("-Mode ProductE2E");
  expect(workflow).toContain("-Mode Package");
  expect(workflow).toContain("-Mode Lifecycle");
  expect(workflow).not.toContain("shell: bash");
  expect(workflow).not.toMatch(/run:\s*(?:bash|sh)\b/u);
  expect(entrypoint).not.toMatch(/\.sh(?:\s|")/u);
  expect(entrypoint).toContain("Invoke-StandardUserSmoke");
  expect(entrypoint).toContain("run-standard-user-bundled-payload-smoke.ps1");
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
});
