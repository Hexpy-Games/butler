import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runWindowsAppBtccProductHarness } from
  "../../packages/butler-app/scripts/windows/windows-app-btcc-product-harness.ts";

test("Windows validation runs the full product once and platform lifecycle twice", () => {
  const entrypoint = readFileSync(
    resolve(
      import.meta.dir,
      "../../packages/butler-app/scripts/windows/run-windows-ci.ps1",
    ),
    "utf8",
  );
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
  expect(source).toContain("windows-app-btcc-product-harness.ts");
  expect(source).toContain('"--browser"');
  expect(source).toContain("browserProjection: appBtcc.browserProjection === true");
  const productMode = entrypoint.match(/"ProductE2E"\s*\{([\s\S]*?)\n {2}\}/u)?.[1];
  expect(productMode).toContain("windows-product-loop-smoke.ts");
  expect(productMode).toContain("-InteractiveDesktop");
  expect(source).toContain("btcc-project-work-ledger-session.test.ts");
  expect(source).toContain("btcc-production-operations.test.ts");
  expect(source).toContain("platform-command-executor.test.ts");
  expect(source).toContain("btcc-command-sandbox.test.ts");
  expect(source).not.toContain("app-client-multiturn-e2e.ts");
  expect(source).not.toMatch(
    /(?:appIngress|deterministicConversation|conversationContinuity|restartDataReload): true/,
  );
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

test("Windows App BTCC harness exercises HTTP ingress and durable projection", async () => {
  const result = await runWindowsAppBtccProductHarness();
  expect(result).toMatchObject({
    ok: true,
    appIngress: true,
    deterministicConversation: true,
    conversationContinuity: true,
    canonicalProjection: true,
    restartDataReload: true,
    modelCalls: 2,
    browserProjection: null,
    rawTextIncluded: false,
  });
});

test("Windows validation references only current repository tests and harnesses", () => {
  const root = resolve(import.meta.dir, "../..");
  const sources = [
    "packages/butler-app/scripts/windows/run-windows-ci.ps1",
    "packages/butler-app/scripts/windows/windows-product-loop-smoke.ts",
  ].map((path) => readFileSync(resolve(root, path), "utf8"));
  const references = sources.flatMap((source) =>
    [...source.matchAll(/"((?:tests|packages)\/[^"]+\.(?:test\.ts|ts))"/gu)]
      .map((match) => match[1]!),
  );

  expect(references.length).toBeGreaterThan(0);
  expect(references.filter((path) => !existsSync(resolve(root, path)))).toEqual([]);
  expect(sources.join("\n")).not.toMatch(
    /principal-turn-cancellation|app-agent-supervisor-drain|app-quit-state-machine/iu,
  );
});
