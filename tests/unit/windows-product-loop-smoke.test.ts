import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("Windows validation runs the full product once and platform lifecycle twice", () => {
  const source = readFileSync(
    resolve(
      import.meta.dir,
      "../../packages/butler-app/scripts/windows/windows-product-loop-smoke.ts",
    ),
    "utf8",
  );
  expect(source).toContain("const fullProductPassCount = 1");
  expect(source).toContain("const platformPassCount = 2");
  expect(source).toContain("platformPasses");
  expect(source).toContain('BUTLER_APP_CLIENT_E2E_MODE: "deterministic"');
  expect(source).toContain('BUTLER_APP_CLIENT_E2E_MODE: "toolchain"');
  expect(source).toContain("native runtime can drive the real run_command tool");
  const nativeRuntime = readFileSync(
    resolve(import.meta.dir, "native-tool-loop-runtime.test.ts"),
    "utf8",
  );
  expect(nativeRuntime).not.toContain("timeout_ms: 120_000");
  const legacyCommandBoundary = readFileSync(
    resolve(
      import.meta.dir,
      "../../packages/butler-agent/src/runtime/command/legacy-command-compat.ts",
    ),
    "utf8",
  );
  expect(legacyCommandBoundary).toContain("stdin: input.command");
  expect(legacyCommandBoundary).not.toContain("legacy-command-host");
  expect(source).toContain("inbound-queue.test.ts");
  expect(source).toContain("app-worker-cancel.test.ts");
  expect(source).toContain("native scheduler claims due automations");
  expect(source).toContain("active-work-cancellation-smoke.ts");
  expect(source).toContain("unpacked-foreground-app-smoke.ts");
  expect(source).toContain("app-foreground-lifecycle-smoke.ts");
  const unpackedForeground = readFileSync(
    resolve(
      import.meta.dir,
      "../../packages/butler-app/scripts/windows/unpacked-foreground-app-smoke.ts",
    ),
    "utf8",
  );
  expect(unpackedForeground).toContain("timeoutMs: 150_000");
  expect(unpackedForeground).toContain("waitForProcessDeath(");
  expect(unpackedForeground).toContain("agentHostStopped");
  expect(unpackedForeground).toContain("recordedPortReleased");
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
  expect(standardUserRunner).toContain('"*S-1-5-32-545:(OI)(CI)M"');
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
