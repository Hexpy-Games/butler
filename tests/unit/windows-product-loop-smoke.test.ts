import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("Windows full-product validation runs the clean isolated loop twice", () => {
  const source = readFileSync(
    resolve(
      import.meta.dir,
      "../../packages/butler-app/scripts/windows/windows-product-loop-smoke.ts",
    ),
    "utf8",
  );
  expect(source).toContain("const passCount = 2");
  expect(source).toContain('BUTLER_APP_CLIENT_E2E_MODE: "deterministic"');
  expect(source).toContain('BUTLER_APP_CLIENT_E2E_MODE: "toolchain"');
  expect(source).toContain("native runtime can drive the real run_command tool");
  expect(source).toContain("inbound-queue.test.ts");
  expect(source).toContain("app-worker-cancel.test.ts");
  expect(source).toContain("native scheduler claims due automations");
  expect(source).toContain("active-work-cancellation-smoke.ts");
  expect(source).toContain("unpacked-foreground-app-smoke.ts");
  expect(source).toContain("app-foreground-lifecycle-smoke.ts");
  expect(source).toContain("waitForE2eTempCleanup(initialE2eTempDirs)");
  expect(source).toContain('spawnSync("taskkill.exe"');
  expect(source).toContain("}, 300_000);");
  const standardUserRunner = readFileSync(
    resolve(
      import.meta.dir,
      "../../packages/butler-app/scripts/windows/run-standard-user-bundled-payload-smoke.ps1",
    ),
    "utf8",
  );
  expect(standardUserRunner).toContain(
    "-not (Test-Path -LiteralPath $Output)",
  );
  expect(standardUserRunner).toContain("-AllowStartIfOnBatteries");
  expect(standardUserRunner).toContain("New-LocalUser");
  expect(standardUserRunner).toContain("SeBatchLogonRight");
  expect(standardUserRunner).toContain("LsaRemoveAccountRights");
  expect(standardUserRunner).toContain("Remove-LocalUser");
  expect(standardUserRunner).toContain("$env:ProgramData");
  expect(
    readFileSync(
      resolve(
        import.meta.dir,
        "../../packages/butler-app/scripts/windows/interactive-smoke-controller.ts",
      ),
      "utf8",
    ),
  ).toContain("BUTLER_WINDOWS_PROCESS_HOST: signedHost");
});
