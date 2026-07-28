import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";
import { createAppDependencyClosureManifest } from "../../packages/butler-app/scripts/release/manifest.ts";
import {
  APP_MANAGED_RUNTIME_UPDATE_TRANSACTION_SCHEMA,
  APP_MANAGED_RUNTIME_POINTER_SCHEMA,
  activateAppManagedAgentRuntime,
  appManagedAgentPointerPath,
  appManagedAgentCandidateBootTokenPath,
  appManagedAgentUpdateTransactionPath,
  beginAppManagedAgentRuntimeUpdate,
  consumeAppManagedAgentCandidateBootToken,
  markAppManagedAgentRuntimeCandidateReady,
  prepareAppManagedAgentRuntime,
  promoteAppManagedAgentRuntimeCandidate,
  readAppManagedAgentRuntimeUpdateTransaction,
  recoverAppManagedAgentRuntimeUpdateTransaction,
  resolveAppManagedGatewayCommand,
  resolveAppManagedForegroundCommand,
  rollbackAppManagedAgentRuntimeUpdate,
  windowsAppForegroundCommand,
  windowsRuntimeSignatureIssue,
} from "../../packages/butler-app/client/electron/app-managed-runtime.mjs";

const repoRoot = process.cwd();

test("Windows runtime signature metadata pins the signed runtime files", () => {
  const runtime = mkdtempSync(join(tmpdir(), "butler-windows-signature-"));
  try {
    mkdirSync(join(runtime, "bin"), { recursive: true });
    writeFileSync(join(runtime, "bin", "bun.exe"), "signed bun\n");
    writeFileSync(
      join(runtime, "bin", "butler-process-host.exe"),
      "signed process host\n",
    );
    const thumbprint = "A".repeat(40);
    writeFileSync(
      join(runtime, "windows-signatures.json"),
      `${JSON.stringify({
        schema: "butler.windows-runtime-signatures.v1",
        verification: "authenticode-powershell-5.1",
        files: [
          {
            path: "bin/bun.exe",
            sha256: sha256File(join(runtime, "bin", "bun.exe")),
            status: "Valid",
            signerThumbprint: thumbprint,
            signerSubject: "CN=Butler Windows Payload Test",
          },
          {
            path: "bin/butler-process-host.exe",
            sha256: sha256File(join(runtime, "bin", "butler-process-host.exe")),
            status: "Valid",
            signerThumbprint: thumbprint,
            signerSubject: "CN=Butler Windows Payload Test",
          },
        ],
        rawTextIncluded: false,
      }, null, 2)}\n`,
    );
    expect(windowsRuntimeSignatureIssue(runtime)).toBeNull();
    writeFileSync(join(runtime, "bin", "bun.exe"), "tampered\n");
    expect(windowsRuntimeSignatureIssue(runtime)).toBe(
      "Windows runtime signature verification failed for bin/bun.exe",
    );
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("App-managed runtime activation writes an app-owned pointer only", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-runtime-"));
  try {
    const butlerData = join(tempDir, "data");
    const resourceRoot = createBundledAgentResource(tempDir, {
      version: "9.9.9",
    });

    const result = activateAppManagedAgentRuntime({
      butlerData,
      resourceRoot,
      now: fixedNow,
    });

    expect(result).toMatchObject({
      runtimeHomeLabel: join("app", "runtime", "agent", "versions", "9.9.9"),
      version: "9.9.9",
      activated: true,
      previousRuntimePath: null,
    });
    expect(existsSync(join(result.runtimeHome, "bin", "butler.js"))).toBe(true);
    expect(
      existsSync(
        join(
          result.runtimeHome,
          "packages",
          "butler-agent",
          "resources",
          "runtime",
          "bun-version",
        ),
      ),
    ).toBe(true);
    expect(existsSync(join(butlerData, "runtime", "agent", "current.json"))).toBe(false);

    const pointer = readJson(appManagedAgentPointerPath(butlerData));
    expect(pointer).toMatchObject({
      schema: APP_MANAGED_RUNTIME_POINTER_SCHEMA,
      product: "butler-app",
      bundled_agent_product: "butler-agent",
      bundled_agent_version: "9.9.9",
      gateway_profile: "electron",
      version: "9.9.9",
      runtime_home: join("app", "runtime", "agent", "versions", "9.9.9"),
      raw_text_included: false,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App-managed runtime activation preserves previous pointer on failed activation", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-runtime-rollback-"));
  try {
    const butlerData = join(tempDir, "data");
    const previousRuntime = join("app", "runtime", "agent", "versions", "1.0.0");
    mkdirSync(join(butlerData, previousRuntime, "bin"), { recursive: true });
    mkdirSync(
      join(butlerData, previousRuntime, "packages", "butler-agent", "resources", "runtime"),
      { recursive: true },
    );
    writeFileSync(join(butlerData, previousRuntime, "bin", "butler.js"), "");
    writeFileSync(
      join(
        butlerData,
        previousRuntime,
        "packages",
        "butler-agent",
        "resources",
        "runtime",
        "bun-version",
      ),
      "1.3.11\n",
    );
    mkdirSync(join(butlerData, "app", "runtime", "agent"), { recursive: true });
    writeFileSync(
      appManagedAgentPointerPath(butlerData),
      `${JSON.stringify({
        schema: APP_MANAGED_RUNTIME_POINTER_SCHEMA,
        product: "butler-app",
        gateway_profile: "electron",
        version: "1.0.0",
        runtime_home: previousRuntime,
      }, null, 2)}\n`,
    );
    const resourceRoot = createBundledAgentResource(join(tempDir, "Alice Smith"), {
      version: "2.0.0",
      sha256: "bad-digest",
    });

    expect(() =>
      activateAppManagedAgentRuntime({
        butlerData,
        resourceRoot,
        now: fixedNow,
      }),
    ).toThrow("digest mismatch");

    const pointer = readJson(appManagedAgentPointerPath(butlerData));
    expect(pointer).toMatchObject({
      version: "1.0.0",
      runtime_home: previousRuntime,
    });
    const failure = readJson(
      join(butlerData, "app", "runtime", "agent", "failures", "2.0.0.json"),
    );
    expect(failure).toMatchObject({
      activation_status: "rolled_back",
      bundled_agent_version: "2.0.0",
      managed_runtime_sha256: null,
      raw_text_included: false,
      rollback_reason: "bundled Agent artifact digest mismatch",
      source_resource_path: "[redacted-path]",
    });
    expect(JSON.stringify(failure)).not.toContain(tempDir);
    expect(JSON.stringify(failure)).not.toContain("Alice Smith");
    expect(existsSync(join(butlerData, "runtime", "agent", "current.json"))).toBe(false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App-managed runtime publishes a launch pointer before readiness and finalizes it after", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-runtime-commit-"));
  try {
    const butlerData = join(tempDir, "data");
    const previousRuntime = join("app", "runtime", "agent", "versions", "1.0.0");
    mkdirSync(join(butlerData, "app", "runtime", "agent"), { recursive: true });
    writeFileSync(
      appManagedAgentPointerPath(butlerData),
      `${JSON.stringify({
        schema: APP_MANAGED_RUNTIME_POINTER_SCHEMA,
        product: "butler-app",
        gateway_profile: "electron",
        version: "1.0.0",
        runtime_home: previousRuntime,
      }, null, 2)}\n`,
    );
    const resourceRoot = createBundledAgentResource(tempDir, {
      version: "2.0.0",
    });

    const prepared = prepareAppManagedAgentRuntime({
      butlerData,
      resourceRoot,
      now: fixedNow,
    });

    expect(readJson(appManagedAgentPointerPath(butlerData))).toMatchObject({
      version: "1.0.0",
      runtime_home: previousRuntime,
    });
    expect(readJson(join(prepared.runtimeHome, "runtime.json"))).toMatchObject({
      activation_status: "prepared",
      selected_at: null,
    });

    expect("publishLaunchPointer" in prepared).toBe(true);
    (prepared as typeof prepared & { publishLaunchPointer(): void }).publishLaunchPointer();
    expect(readJson(appManagedAgentPointerPath(butlerData))).toMatchObject({
      version: "2.0.0",
      runtime_home: join("app", "runtime", "agent", "versions", "2.0.0"),
      selected_at: null,
      previous: {
        version: "1.0.0",
        runtime_home: previousRuntime,
      },
    });

    prepared.commitActivation();
    expect(readJson(appManagedAgentPointerPath(butlerData))).toMatchObject({
      version: "2.0.0",
      runtime_home: join("app", "runtime", "agent", "versions", "2.0.0"),
      previous: {
        version: "1.0.0",
        runtime_home: previousRuntime,
      },
    });
    expect(readJson(join(prepared.runtimeHome, "runtime.json"))).toMatchObject({
      activation_status: "activated",
      selected_at: "2026-06-12T00:00:00.000Z",
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App-managed runtime rollback hook restores previous prepared runtime after health failure", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-runtime-health-rollback-"));
  try {
    const butlerData = join(tempDir, "data");
    const currentRuntime = join("app", "runtime", "agent", "versions", "2.0.0");
    const standaloneRuntime = join("runtime", "agent", "versions", "9.0.0");
    writeReadyRuntime(butlerData, currentRuntime);
    writeFileSync(join(butlerData, currentRuntime, "bin", "butler.js"), "previous launcher\n");
    mkdirSync(join(butlerData, "app", "runtime", "agent"), { recursive: true });
    writeFileSync(
      appManagedAgentPointerPath(butlerData),
      `${JSON.stringify({
        schema: APP_MANAGED_RUNTIME_POINTER_SCHEMA,
        product: "butler-app",
        gateway_profile: "electron",
        version: "2.0.0",
        runtime_home: currentRuntime,
      }, null, 2)}\n`,
    );
    mkdirSync(join(butlerData, "runtime", "agent"), { recursive: true });
    writeFileSync(
      join(butlerData, "runtime", "agent", "current.json"),
      `${JSON.stringify({
        schema: "butler.agent-standalone-runtime-pointer.v1",
        product: "butler-agent",
        profile: "agent-standalone",
        version: "9.0.0",
        runtime_home: standaloneRuntime,
      }, null, 2)}\n`,
    );
    const standalonePointerBefore = readFileSync(
      join(butlerData, "runtime", "agent", "current.json"),
      "utf8",
    );
    const resourceRoot = createBundledAgentResource(join(tempDir, "Private User"), {
      version: "2.0.0",
    });

    const prepared = prepareAppManagedAgentRuntime({
      butlerData,
      resourceRoot,
      now: fixedNow,
    });
    expect(readFileSync(join(prepared.runtimeHome, "bin", "butler.js"), "utf8")).toContain(
      "#!/usr/bin/env node",
    );

    (prepared as any).rollbackActivation(new Error("health check failed at /Users/private/token"));

    expect(readFileSync(join(butlerData, currentRuntime, "bin", "butler.js"), "utf8")).toBe(
      "previous launcher\n",
    );
    expect(readJson(appManagedAgentPointerPath(butlerData))).toMatchObject({
      version: "2.0.0",
      runtime_home: currentRuntime,
    });
    expect(readFileSync(join(butlerData, "runtime", "agent", "current.json"), "utf8")).toBe(
      standalonePointerBefore,
    );
    const failure = readJson(
      join(butlerData, "app", "runtime", "agent", "failures", "2.0.0.json"),
    );
    expect(failure).toMatchObject({
      activation_status: "rolled_back",
      rollback_reason: "health check failed at [redacted-path]",
      raw_text_included: false,
    });
    expect(JSON.stringify(failure)).not.toContain(tempDir);
    expect(JSON.stringify(failure)).not.toContain("Private User");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "App-managed runtime rejects unsafe bundled Agent archive entries",
  () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-runtime-unsafe-"));
  try {
    const resourceRoot = createBundledAgentResource(tempDir, {
      version: "4.0.0",
      symlink: true,
      unsafeSymlink: true,
    });
    expect(() =>
      activateAppManagedAgentRuntime({
        butlerData: join(tempDir, "data"),
        resourceRoot,
        now: fixedNow,
      }),
    ).toThrow("unsafe symlink");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  },
);

test("App-managed runtime rejects directory launcher archive entries", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-runtime-dir-launcher-"));
  try {
    const resourceRoot = createBundledAgentResource(tempDir, {
      version: "4.1.0",
      launcherDirectory: true,
    });
    expect(() =>
      activateAppManagedAgentRuntime({
        butlerData: join(tempDir, "data"),
        resourceRoot,
        now: fixedNow,
      }),
    ).toThrow("missing bin/butler.js");
    expect(existsSync(appManagedAgentPointerPath(join(tempDir, "data")))).toBe(false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App-managed runtime verifies dependency closure checksums before activation", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-runtime-closure-"));
  try {
    const butlerData = join(tempDir, "data");
    const resourceRoot = createBundledAgentResource(tempDir, {
      version: "5.0.0",
    });
    const closurePath = join(resourceRoot, "dependency-closure.json");
    const closure = readJson(closurePath);
    closure.appOwnedDependencies.find(
      (item: any) => item.id === "managed-runtime-payload",
    ).integrity.digest = "bad-digest";
    writeFileSync(closurePath, `${JSON.stringify(closure, null, 2)}\n`);

    expect(() =>
      activateAppManagedAgentRuntime({
        butlerData,
        resourceRoot,
        now: fixedNow,
      }),
    ).toThrow("managed-runtime-payload digest mismatch");

    const failure = readJson(
      join(butlerData, "app", "runtime", "agent", "failures", "5.0.0.json"),
    );
    expect(failure).toMatchObject({
      activation_status: "rolled_back",
      raw_text_included: false,
      rollback_reason: "dependency closure managed-runtime-payload digest mismatch",
      source_resource_path: "[redacted-path]",
    });
    expect(JSON.stringify(failure)).not.toContain(tempDir);
    expect(JSON.stringify(failure)).not.toContain(resourceRoot);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App-managed runtime fails closed for signed bundled Agent metadata", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-runtime-signed-"));
  try {
    const resourceRoot = createBundledAgentResource(tempDir, {
      version: "5.1.0",
      signature: "test-signature",
    });

    expect(() =>
      activateAppManagedAgentRuntime({
        butlerData: join(tempDir, "data"),
        resourceRoot,
        now: fixedNow,
      }),
    ).toThrow("signed artifacts must fail closed");
    expect(existsSync(appManagedAgentPointerPath(join(tempDir, "data")))).toBe(false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App-managed runtime fails closed for signed dependency closure metadata", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-runtime-signed-closure-"));
  try {
    const resourceRoot = createBundledAgentResource(tempDir, {
      version: "5.2.0",
    });
    const closurePath = join(resourceRoot, "dependency-closure.json");
    const closure = readJson(closurePath);
    closure.appOwnedDependencies.find(
      (item: any) => item.id === "managed-runtime-payload",
    ).integrity.signature = "test-signature";
    writeFileSync(closurePath, `${JSON.stringify(closure, null, 2)}\n`);

    expect(() =>
      activateAppManagedAgentRuntime({
        butlerData: join(tempDir, "data"),
        resourceRoot,
        now: fixedNow,
      }),
    ).toThrow("signed artifacts must fail closed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App-managed runtime fails closed for signed update manifest metadata", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-runtime-signed-update-"));
  try {
    const resourceRoot = createBundledAgentResource(tempDir, {
      version: "5.3.0",
    });
    const updateManifestPath = join(resourceRoot, "agent-update-manifest.json");
    const updateManifest = readJson(updateManifestPath);
    updateManifest.artifacts[0].signature = { unsupported: true };
    writeFileSync(updateManifestPath, `${JSON.stringify(updateManifest, null, 2)}\n`);

    expect(() =>
      activateAppManagedAgentRuntime({
        butlerData: join(tempDir, "data"),
        resourceRoot,
        now: fixedNow,
      }),
    ).toThrow("signed artifacts must fail closed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App-managed runtime repairs damaged selected runtime from App-owned payload", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-runtime-repair-"));
  try {
    const butlerData = join(tempDir, "data");
    const resourceRoot = createBundledAgentResource(tempDir, {
      version: "6.0.0",
    });
    const first = activateAppManagedAgentRuntime({
      butlerData,
      resourceRoot,
      now: fixedNow,
    });
    rmSync(join(first.runtimeHome, "bin"), { recursive: true, force: true });
    rmSync(join(first.runtimeHome, "packages", "butler-agent", "owned-file.txt"), {
      force: true,
    });

    const repaired = activateAppManagedAgentRuntime({
      butlerData,
      resourceRoot,
      now: fixedNow,
    });

    expect(repaired.runtimeHome).toBe(first.runtimeHome);
    expect(existsSync(join(repaired.runtimeHome, "bin", "butler.js"))).toBe(true);
    expect(existsSync(join(repaired.runtimeHome, "packages", "butler-agent", "owned-file.txt"))).toBe(true);
    expect(
      existsSync(
        join(
          repaired.runtimeHome,
          "packages",
          "butler-agent",
          "resources",
          "runtime",
          "bin",
          process.platform === "win32" ? "bun.exe" : "bun",
        ),
      ),
    ).toBe(true);
    expect(readJson(appManagedAgentPointerPath(butlerData))).toMatchObject({
      version: "6.0.0",
      runtime_home: join("app", "runtime", "agent", "versions", "6.0.0"),
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App-managed runtime can roll back a committed service registration activation", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-runtime-post-commit-rollback-"));
  try {
    const butlerData = join(tempDir, "data");
    const firstResource = createBundledAgentResource(join(tempDir, "first"), {
      version: "1.0.0",
    });
    const first = activateAppManagedAgentRuntime({
      butlerData,
      resourceRoot: firstResource,
      now: fixedNow,
    });
    const firstPointer = readJson(appManagedAgentPointerPath(butlerData));
    const nextResource = createBundledAgentResource(join(tempDir, "next"), {
      version: "2.0.0",
    });
    const prepared = prepareAppManagedAgentRuntime({
      butlerData,
      resourceRoot: nextResource,
      now: fixedNow,
    });

    prepared.commitActivation();
    expect(readJson(appManagedAgentPointerPath(butlerData))).toMatchObject({
      version: "2.0.0",
      runtime_home: prepared.runtimeHomeLabel,
    });

    prepared.rollbackActivation(new Error("service registration failed"));

    expect(readJson(appManagedAgentPointerPath(butlerData))).toEqual(firstPointer);
    expect(existsSync(first.runtimeHome)).toBe(true);
    expect(existsSync(prepared.runtimeHome)).toBe(false);
    const failure = readJson(
      join(butlerData, "app", "runtime", "agent", "failures", "2.0.0.json"),
    );
    expect(failure).toMatchObject({
      activation_status: "rolled_back",
      rollback_reason: "service registration failed",
      raw_text_included: false,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App-managed runtime rolls failed same-version repair back to previous runtime", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-runtime-repair-rollback-"));
  try {
    const butlerData = join(tempDir, "data");
    const previousRuntime = join("app", "runtime", "agent", "versions", "1.0.0");
    const currentRuntime = join("app", "runtime", "agent", "versions", "2.0.0");
    writeReadyRuntime(butlerData, previousRuntime);
    mkdirSync(
      join(butlerData, currentRuntime, "packages", "butler-agent", "resources", "runtime"),
      { recursive: true },
    );
    writeFileSync(
      join(
        butlerData,
        currentRuntime,
        "packages",
        "butler-agent",
        "resources",
        "runtime",
        "bun-version",
      ),
      "1.3.11\n",
    );
    mkdirSync(join(butlerData, "app", "runtime", "agent"), { recursive: true });
    writeFileSync(
      appManagedAgentPointerPath(butlerData),
      `${JSON.stringify({
        schema: APP_MANAGED_RUNTIME_POINTER_SCHEMA,
        product: "butler-app",
        gateway_profile: "electron",
        version: "2.0.0",
        runtime_home: currentRuntime,
        previous: {
          schema: APP_MANAGED_RUNTIME_POINTER_SCHEMA,
          product: "butler-app",
          gateway_profile: "electron",
          version: "1.0.0",
          runtime_home: previousRuntime,
        },
      }, null, 2)}\n`,
    );
    const resourceRoot = createBundledAgentResource(tempDir, {
      version: "2.0.0",
      omitLauncher: true,
    });

    expect(() =>
      activateAppManagedAgentRuntime({
        butlerData,
        resourceRoot,
        now: fixedNow,
      }),
    ).toThrow("missing bin/butler.js");

    expect(readJson(appManagedAgentPointerPath(butlerData))).toMatchObject({
      version: "1.0.0",
      runtime_home: previousRuntime,
    });
    expect(existsSync(join(butlerData, previousRuntime, "bin", "butler.js"))).toBe(true);
    expect(existsSync(join(butlerData, currentRuntime))).toBe(true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App-managed runtime activation does not shell out to host tar", () => {
  const source = readFileSync(
    join(repoRoot, "packages", "butler-app", "client", "electron", "app-managed-runtime.mjs"),
    "utf8",
  );
  expect(source).toContain("managedRuntimeSourceExecutablePath");
  expect(source).toContain("windows-archive-worker.mjs");
  expect(source).not.toContain('spawnSync("tar"');
  expect(source).not.toContain('"tar", ["-xzf"');
  expect(source).not.toContain("npm install");
  expect(source).not.toContain("brew install");
  expect(source).not.toContain("apt install");
});

test("App-managed runtime prepares bundled-Agent-only update and rolls back without host tools", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-runtime-agent-only-smoke-"));
  try {
    const butlerData = join(tempDir, "data");
    const previousRuntime = join("app", "runtime", "agent", "versions", "42.0.0");
    writeReadyRuntime(butlerData, previousRuntime);
    mkdirSync(join(butlerData, "app", "runtime", "agent"), { recursive: true });
    writeFileSync(
      appManagedAgentPointerPath(butlerData),
      `${JSON.stringify({
        schema: APP_MANAGED_RUNTIME_POINTER_SCHEMA,
        product: "butler-app",
        bundled_agent_product: "butler-agent",
        bundled_agent_version: "42.0.0",
        gateway_profile: "electron",
        version: "42.0.0",
        runtime_home: previousRuntime,
        raw_text_included: false,
      }, null, 2)}\n`,
    );
    const pointerBefore = readFileSync(appManagedAgentPointerPath(butlerData), "utf8");
    const resourceRoot = createBundledAgentResource(tempDir, {
      version: "42.0.1",
    });
    const blockedHostTools = join(tempDir, "blocked-host-tools");
    const hostToolLog = join(tempDir, "host-tool-calls.log");
    writeHostToolBlockers(blockedHostTools, hostToolLog);

    const previousPath = process.env.PATH;
    const previousHostToolLog = process.env.BUTLER_HOST_TOOL_BLOCK_LOG;
    try {
      process.env.PATH = blockedHostTools;
      process.env.BUTLER_HOST_TOOL_BLOCK_LOG = hostToolLog;
      const prepared = prepareAppManagedAgentRuntime({
        butlerData,
        resourceRoot,
        now: fixedNow,
      });

      expect(prepared).toMatchObject({
        version: "42.0.1",
        runtimeHomeLabel: join("app", "runtime", "agent", "versions", "42.0.1"),
        previousRuntimePath: previousRuntime,
        activated: false,
      });
      expect(existsSync(join(prepared.runtimeHome, "bin", "butler.js"))).toBe(true);
      expect(readFileSync(appManagedAgentPointerPath(butlerData), "utf8")).toBe(pointerBefore);

      prepared.rollbackActivation(new Error("smoke rollback before App shell commit"));

      expect(readFileSync(appManagedAgentPointerPath(butlerData), "utf8")).toBe(pointerBefore);
      expect(existsSync(join(butlerData, previousRuntime, "bin", "butler.js"))).toBe(true);
      expect(existsSync(prepared.runtimeHome)).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousHostToolLog === undefined) delete process.env.BUTLER_HOST_TOOL_BLOCK_LOG;
      else process.env.BUTLER_HOST_TOOL_BLOCK_LOG = previousHostToolLog;
    }

    expect(existsSync(hostToolLog) ? readFileSync(hostToolLog, "utf8").trim() : "").toBe("");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App-managed runtime update transaction promotes candidate only after readiness proof", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-runtime-update-transaction-"));
  try {
    const butlerData = join(tempDir, "data");
    const activePointer = appPointer("1.0.0");
    const candidatePointer = appPointer("2.0.0");
    mkdirSync(join(butlerData, "app", "runtime", "agent"), { recursive: true });
    writeFileSync(
      appManagedAgentPointerPath(butlerData),
      `${JSON.stringify(activePointer, null, 2)}\n`,
    );

    const transaction = beginAppManagedAgentRuntimeUpdate({
      butlerData,
      candidatePointer,
      candidateDigest: "sha256-next",
      generateToken: () => "candidate-token",
      now: fixedNow,
    });

    expect(transaction).toMatchObject({
      schema: APP_MANAGED_RUNTIME_UPDATE_TRANSACTION_SCHEMA,
      status: "restart_required",
      previous_active_pointer: activePointer,
      active_pointer: activePointer,
      candidate_pointer: candidatePointer,
      candidate_digest: "sha256-next",
      candidate_boot_token_hash: sha256TextForTest("candidate-token"),
      readiness_proof: null,
      started_at: "2026-06-12T00:00:00.000Z",
      updated_at: "2026-06-12T00:00:00.000Z",
      raw_text_included: false,
    });
    expect(readJson(appManagedAgentPointerPath(butlerData))).toEqual(activePointer);
    expect(readJson(appManagedAgentCandidateBootTokenPath(butlerData))).toMatchObject({
      generation: transaction.generation,
      candidate_pointer: candidatePointer,
      candidate_digest: "sha256-next",
      token: "candidate-token",
      raw_text_included: false,
    });
    expect(
      consumeAppManagedAgentCandidateBootToken({
        butlerData,
        generation: transaction.generation,
        candidateDigest: "sha256-next",
        token: "candidate-token",
      }),
    ).toEqual({
      generation: transaction.generation,
      candidate_pointer: candidatePointer,
      candidate_digest: "sha256-next",
      raw_text_included: false,
    });
    expect(existsSync(appManagedAgentCandidateBootTokenPath(butlerData))).toBe(false);
    expect(() =>
      consumeAppManagedAgentCandidateBootToken({
        butlerData,
        generation: transaction.generation,
        candidateDigest: "sha256-next",
        token: "candidate-token",
      }),
    ).toThrow("missing candidate");

    expect(() =>
      promoteAppManagedAgentRuntimeCandidate({
        butlerData,
        generation: transaction.generation,
        now: fixedNow,
      }),
    ).toThrow("not ready");
    expect(readJson(appManagedAgentPointerPath(butlerData))).toEqual(activePointer);

    const ready = markAppManagedAgentRuntimeCandidateReady({
      butlerData,
      generation: transaction.generation,
      readinessProof: {
        ok: true,
        runtime_home: "/Users/private/runtime",
        token: "secret-token",
      },
      now: fixedNow,
    });
    expect(ready).toMatchObject({
      status: "candidate_ready",
      readiness_proof: {
        ok: true,
        runtime_home: "[redacted-path]",
        token: "[redacted]",
        raw_text_included: false,
      },
    });

    const promoted = promoteAppManagedAgentRuntimeCandidate({
      butlerData,
      generation: transaction.generation,
      now: fixedNow,
    });
    expect(promoted).toMatchObject({
      status: "ready",
      active_pointer: {
        version: "2.0.0",
        previous: activePointer,
        selected_at: "2026-06-12T00:00:00.000Z",
      },
    });
    expect(readJson(appManagedAgentPointerPath(butlerData))).toMatchObject({
      version: "2.0.0",
      previous: activePointer,
    });
    expect(existsSync(appManagedAgentCandidateBootTokenPath(butlerData))).toBe(false);
    expect(readAppManagedAgentRuntimeUpdateTransaction(butlerData)).toMatchObject({
      status: "ready",
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App-managed candidate boot token is generation locked", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-runtime-update-token-"));
  try {
    const butlerData = join(tempDir, "data");
    mkdirSync(join(butlerData, "app", "runtime", "agent"), { recursive: true });
    writeFileSync(
      appManagedAgentPointerPath(butlerData),
      `${JSON.stringify(appPointer("1.0.0"), null, 2)}\n`,
    );
    const transaction = beginAppManagedAgentRuntimeUpdate({
      butlerData,
      candidatePointer: appPointer("2.0.0"),
      candidateDigest: "sha256-next",
      generateToken: () => "candidate-token",
      now: fixedNow,
    });

    expect(() =>
      consumeAppManagedAgentCandidateBootToken({
        butlerData,
        generation: "older-generation",
        candidateDigest: "sha256-next",
        token: "candidate-token",
      }),
    ).toThrow("missing App-managed Agent runtime update transaction");
    expect(() =>
      consumeAppManagedAgentCandidateBootToken({
        butlerData,
        generation: transaction.generation,
        candidateDigest: "sha256-next",
        token: "wrong-token",
      }),
    ).toThrow("boot token mismatch");
    expect(existsSync(appManagedAgentCandidateBootTokenPath(butlerData))).toBe(true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App-managed runtime update recovery finalizes ready candidate pointer", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-runtime-update-recover-ready-"));
  try {
    const butlerData = join(tempDir, "data");
    const activePointer = appPointer("1.0.0");
    const candidatePointer = appPointer("2.0.0");
    mkdirSync(join(butlerData, "app", "runtime", "agent"), { recursive: true });
    writeFileSync(
      appManagedAgentPointerPath(butlerData),
      `${JSON.stringify(activePointer, null, 2)}\n`,
    );
    const transaction = beginAppManagedAgentRuntimeUpdate({
      butlerData,
      candidatePointer,
      candidateDigest: "sha256-next",
      generateToken: () => "candidate-token",
      now: fixedNow,
    });
    markAppManagedAgentRuntimeCandidateReady({
      butlerData,
      generation: transaction.generation,
      readinessProof: { ok: true },
      now: fixedNow,
    });
    writeFileSync(
      appManagedAgentPointerPath(butlerData),
      `${JSON.stringify(candidatePointer, null, 2)}\n`,
    );

    const recovered = recoverAppManagedAgentRuntimeUpdateTransaction({
      butlerData,
      now: fixedNow,
    });

    expect(recovered).toMatchObject({
      status: "ready",
      active_pointer: candidatePointer,
      last_error: null,
      raw_text_included: false,
    });
    expect(existsSync(appManagedAgentCandidateBootTokenPath(butlerData))).toBe(false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App-managed runtime update recovery rolls back unready candidate pointer", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-runtime-update-recover-rollback-"));
  try {
    const butlerData = join(tempDir, "data");
    const activePointer = appPointer("1.0.0");
    const candidatePointer = appPointer("2.0.0");
    mkdirSync(join(butlerData, "app", "runtime", "agent"), { recursive: true });
    writeFileSync(
      appManagedAgentPointerPath(butlerData),
      `${JSON.stringify(activePointer, null, 2)}\n`,
    );
    beginAppManagedAgentRuntimeUpdate({
      butlerData,
      candidatePointer,
      candidateDigest: "sha256-next",
      generateToken: () => "candidate-token",
      now: fixedNow,
    });
    writeFileSync(
      appManagedAgentPointerPath(butlerData),
      `${JSON.stringify(candidatePointer, null, 2)}\n`,
    );

    const recovered = recoverAppManagedAgentRuntimeUpdateTransaction({
      butlerData,
      now: fixedNow,
    });

    expect(recovered).toMatchObject({
      status: "rollback",
      active_pointer: activePointer,
      last_error: "recovered unready candidate pointer",
      raw_text_included: false,
    });
    expect(readJson(appManagedAgentPointerPath(butlerData))).toEqual(activePointer);
    expect(existsSync(appManagedAgentCandidateBootTokenPath(butlerData))).toBe(false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App-managed runtime update recovery rolls back missing candidate token", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-runtime-update-recover-token-"));
  try {
    const butlerData = join(tempDir, "data");
    const activePointer = appPointer("1.0.0");
    mkdirSync(join(butlerData, "app", "runtime", "agent"), { recursive: true });
    writeFileSync(
      appManagedAgentPointerPath(butlerData),
      `${JSON.stringify(activePointer, null, 2)}\n`,
    );
    beginAppManagedAgentRuntimeUpdate({
      butlerData,
      candidatePointer: appPointer("2.0.0"),
      candidateDigest: "sha256-next",
      generateToken: () => "candidate-token",
      now: fixedNow,
    });
    rmSync(appManagedAgentCandidateBootTokenPath(butlerData), { force: true });

    const recovered = recoverAppManagedAgentRuntimeUpdateTransaction({
      butlerData,
      now: fixedNow,
    });

    expect(recovered).toMatchObject({
      status: "rollback",
      active_pointer: activePointer,
      last_error: "recovered missing candidate boot token",
      raw_text_included: false,
    });
    expect(readJson(appManagedAgentPointerPath(butlerData))).toEqual(activePointer);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App-managed runtime update transaction rolls back to previous active pointer", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-runtime-update-rollback-"));
  try {
    const butlerData = join(tempDir, "data");
    const activePointer = appPointer("1.0.0");
    mkdirSync(join(butlerData, "app", "runtime", "agent"), { recursive: true });
    writeFileSync(
      appManagedAgentPointerPath(butlerData),
      `${JSON.stringify(activePointer, null, 2)}\n`,
    );
    const transaction = beginAppManagedAgentRuntimeUpdate({
      butlerData,
      candidatePointer: appPointer("2.0.0"),
      candidateDigest: "sha256-next",
      generateToken: () => "candidate-token",
      now: fixedNow,
    });

    const rollback = rollbackAppManagedAgentRuntimeUpdate({
      butlerData,
      generation: transaction.generation,
      error: new Error("failed at /Users/private/runtime-token"),
      now: fixedNow,
    });

    expect(rollback).toMatchObject({
      status: "rollback",
      active_pointer: activePointer,
      last_error: "failed at [redacted-path]",
      raw_text_included: false,
    });
    expect(readJson(appManagedAgentPointerPath(butlerData))).toEqual(activePointer);
    expect(existsSync(appManagedAgentCandidateBootTokenPath(butlerData))).toBe(false);
    expect(readJson(appManagedAgentUpdateTransactionPath(butlerData))).toMatchObject({
      status: "rollback",
      last_error: "failed at [redacted-path]",
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App-managed gateway command uses App runtime instead of standalone BUTLER_HOME", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-runtime-command-"));
  try {
    const butlerData = join(tempDir, "data");
    const resourceRoot = createBundledAgentResource(tempDir, {
      version: "3.0.0",
    });
    const standaloneHome = join(tempDir, "standalone");
    const command = resolveAppManagedGatewayCommand({
      butlerData,
      env: {
        BUTLER_HOME: standaloneHome,
        BUTLER_APP_BUNDLED_AGENT_DIR: resourceRoot,
      },
      resourcesPath: join(tempDir, "missing-resources"),
    });

    expect(command).not.toBeNull();
    if (!command) throw new Error("expected app-managed gateway command");
    const appBundledBun = join(
      command.cwd,
      "packages",
      "butler-agent",
      "resources",
      "runtime",
      "bin",
      process.platform === "win32" ? "bun.exe" : "bun",
    );
    expect(command.command).toBe(appBundledBun);
    expect(command.cwd).toBe(join(butlerData, "app", "runtime", "agent", "versions", "3.0.0"));
    expect(command.args).toEqual([
      join(command.cwd, "bin", "butler.js"),
      "gateway",
      "app",
    ]);
    expect(command.env).toMatchObject({
      BUTLER_HOME: command.cwd,
      BUTLER_APP_BUTLER_HOME: command.cwd,
      BUTLER_DATA: butlerData,
      BUTLER_BUN: appBundledBun,
      BUTLER_APP_MANAGED_RUNTIME_HOME: command.cwd,
    });
    expect(command.env.BUTLER_HOME).not.toBe(standaloneHome);
    expect(existsSync(appManagedAgentPointerPath(butlerData))).toBe(false);
    command.commitActivation();
    expect(readJson(appManagedAgentPointerPath(butlerData))).toMatchObject({
      version: "3.0.0",
    });
    expect(existsSync(join(butlerData, "runtime", "agent", "current.json"))).toBe(false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App-managed foreground command uses the platform owner with a parent lease", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-foreground-command-"));
  try {
    const butlerData = join(tempDir, "data");
    const resourceRoot = createBundledAgentResource(tempDir, { version: "3.1.0" });
    const command = resolveAppManagedForegroundCommand({
      butlerData,
      env: { BUTLER_APP_BUNDLED_AGENT_DIR: resourceRoot },
      resourcesPath: join(tempDir, "missing-resources"),
    });
    expect(command).not.toBeNull();
    if (!command) throw new Error("expected App foreground command");
    const runtimeBin = join(
      command.cwd,
      "packages",
      "butler-agent",
      "resources",
      "runtime",
      "bin",
    );
    if (process.platform === "win32") {
      expect(command.command).toBe(join(runtimeBin, "butler-process-host.exe"));
      expect(command.args).toEqual([
        "--owner-pid",
        String(process.pid),
        join(runtimeBin, "bun.exe"),
        join(command.cwd, "bin", "butler.js"),
        "gateway",
        "app",
      ]);
      expect(command.stdio).toEqual(["ignore", "inherit", "inherit"]);
      expect(command.detached).toBe(false);
    } else {
      expect(command.command).toBe(join(runtimeBin, "bun"));
      expect(command.args).toEqual([
        "run",
        join(command.cwd, "packages/butler-agent/scripts/native-service-daemon.ts"),
      ]);
      expect(command.stdio).toEqual(["pipe", "inherit", "inherit"]);
      expect(command.detached).toBe(true);
    }
    expect(command.env).toMatchObject({
      BUTLER_APP_MANAGED_RUNTIME_HOME: command.cwd,
      BUTLER_DATA: butlerData,
    });
    if (process.platform === "win32") {
      expect(command.env.BUTLER_APP_FOREGROUND_LEASE).toBeUndefined();
    } else {
      expect(command.env.BUTLER_APP_FOREGROUND_LEASE).toBe("1");
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Windows App foreground command uses the owner-death Job host and foreground daemon", () => {
  const command = windowsAppForegroundCommand({
    runtimeHome: "C:\\Users\\테스터\\Butler Data\\runtime",
    runtime: "C:\\Users\\테스터\\Butler Data\\runtime\\bin\\bun.exe",
    processHost:
      "C:\\Users\\테스터\\Butler Data\\runtime\\bin\\butler-process-host.exe",
    daemon: "C:\\Users\\테스터\\Butler Data\\runtime\\packages\\butler-agent\\scripts\\native-service-daemon.ts",
    ownerPid: 4242,
  });

  expect(command).toEqual({
    command:
      "C:\\Users\\테스터\\Butler Data\\runtime\\bin\\butler-process-host.exe",
    args: [
      "--owner-pid",
      "4242",
      "C:\\Users\\테스터\\Butler Data\\runtime\\bin\\bun.exe",
      "run",
      "C:\\Users\\테스터\\Butler Data\\runtime\\packages\\butler-agent\\scripts\\native-service-daemon.ts",
    ],
    cwd: "C:\\Users\\테스터\\Butler Data\\runtime",
    stdio: ["ignore", "inherit", "inherit"],
    detached: false,
  });
  expect(() => windowsAppForegroundCommand({
    runtimeHome: "C:\\runtime",
    runtime: "bun.exe",
    processHost: "butler-process-host.exe",
    daemon: "native-service-daemon.ts",
    ownerPid: 0,
  })).toThrow("owner PID");
});

function createBundledAgentResource(
  root: string,
  input: {
    version: string;
    sha256?: string;
    symlink?: boolean;
    unsafeSymlink?: boolean;
    signature?: string;
    omitLauncher?: boolean;
    launcherDirectory?: boolean;
  },
): string {
  const resourceRoot = join(root, `resource-${input.version}`);
  const stageRoot = join(root, `stage-${input.version}`);
  const artifactName = `butler-agent-${input.version}-all.tar.gz`;
  if (input.launcherDirectory) {
    mkdirSync(join(stageRoot, "bin", "butler.js"), { recursive: true });
  } else if (!input.omitLauncher) {
    mkdirSync(join(stageRoot, "bin"), { recursive: true });
    writeFileSync(join(stageRoot, "bin", "butler.js"), "#!/usr/bin/env node\n");
  }
  mkdirSync(join(stageRoot, "packages", "butler-agent", "resources", "runtime"), {
    recursive: true,
  });
  mkdirSync(join(stageRoot, "packages", "butler-agent"), {
    recursive: true,
  });
  mkdirSync(join(stageRoot, "packages", "butler-agent", "scripts"), {
    recursive: true,
  });
  writeFileSync(
    join(stageRoot, "packages", "butler-agent", "scripts", "native-service-daemon.ts"),
    "await Promise.resolve();\n",
  );
  writeFileSync(join(stageRoot, "packages", "butler-agent", "owned-file.txt"), "owned\n");
  writeFileSync(
    join(stageRoot, "packages", "butler-agent", "resources", "runtime", "bun-version"),
    "1.3.11\n",
  );
  if (input.symlink) {
    const link = spawnSync(
      "ln",
      ["-s", input.unsafeSymlink ? "../escape" : "bin/butler.js", join(stageRoot, "unsafe-link")],
      { encoding: "utf8" },
    );
    expect(link.status).toBe(0);
  }
  mkdirSync(resourceRoot, { recursive: true });
  const artifactPath = join(resourceRoot, artifactName);
  const tar = spawnSync("tar", ["-czf", artifactPath, "-C", stageRoot, "."], {
    encoding: "utf8",
  });
  expect(tar.status).toBe(0);
  mkdirSync(join(resourceRoot, "runtime"), { recursive: true });
  writeFileSync(join(resourceRoot, "runtime", "bun-version"), "1.3.11\n");
  if (process.platform === "win32") {
    writeWindowsRuntimeFixture(join(resourceRoot, "runtime"));
    copyFileSync(
      join(repoRoot, "packages", "butler-agent", "resources", "runtime", "windows-archive-worker.mjs"),
      join(resourceRoot, "runtime", "windows-archive-worker.mjs"),
    );
  } else {
    mkdirSync(join(resourceRoot, "runtime", "bin"), { recursive: true });
    writeFileSync(join(resourceRoot, "runtime", "bin", "bun"), "#!/bin/sh\n", {
      mode: 0o755,
    });
  }
  const sha256 = input.sha256 ?? sha256File(artifactPath);
  writeFileSync(
    join(resourceRoot, "agent-release-manifest.json"),
    `${JSON.stringify({
      artifacts: [
        {
          component: "service",
          product: "butler-agent",
          canonicalComponent: "agent",
          version: input.version,
          artifactName,
          sha256,
          signature: input.signature ?? null,
          integrity: {
            digestAlgorithm: "sha256",
            digest: sha256,
            signature: input.signature ?? null,
          },
        },
      ],
    }, null, 2)}\n`,
  );
  writeFileSync(
    join(resourceRoot, "agent-update-manifest.json"),
    `${JSON.stringify({
      artifacts: [
        {
          artifact_url: `bundled-agent/${artifactName}`,
          sha256,
        },
      ],
    }, null, 2)}\n`,
  );
  const releaseManifestSha256 = sha256File(join(resourceRoot, "agent-release-manifest.json"));
  const updateManifestSha256 = sha256File(join(resourceRoot, "agent-update-manifest.json"));
  writeFileSync(
    join(resourceRoot, "background-service-capability.json"),
    `${JSON.stringify({
      schema: "butler.app-background-service-capability.v1",
      serviceCapable: true,
      gatewayProfile: "electron",
      appGatewayOwner: "background-agent-service",
      rawTextIncluded: false,
    }, null, 2)}\n`,
  );
  writeFileSync(
    join(resourceRoot, "background-service-registration.json"),
    `${JSON.stringify({
      schema: "butler.app-background-service-registration.v1",
      product: "butler-app",
      releasePlatform: "darwin-arm64",
      servicePlatform: "darwin",
      gatewayProfile: "electron",
      rawTextIncluded: false,
    }, null, 2)}\n`,
  );
  const backgroundServiceCapabilitySha256 = sha256File(
    join(resourceRoot, "background-service-capability.json"),
  );
  const backgroundServiceRegistrationSha256 = sha256File(
    join(resourceRoot, "background-service-registration.json"),
  );
  mkdirSync(join(resourceRoot, "service-installer", "darwin", "launchd"), {
    recursive: true,
  });
  writeFileSync(
    join(resourceRoot, "service-installer", "darwin", "launchd", "render-contract.json"),
    `${JSON.stringify({
      schema: "butler.app-service-render-contract.v1",
      platform: "darwin",
      manager: "launchd",
      requiredEscaping: "xml",
      rawTemplateIncluded: false,
      rawTextIncluded: false,
    }, null, 2)}\n`,
  );
  const backgroundServiceInstallerPayloadSha256 = sha256Directory(
    join(resourceRoot, "service-installer"),
  );
  const backgroundServiceRegistrationMetadataSha256 = sha256Values([
    backgroundServiceCapabilitySha256,
    backgroundServiceRegistrationSha256,
    backgroundServiceInstallerPayloadSha256,
  ]);
  const managedRuntimeSha256 = sha256Directory(
    join(resourceRoot, "runtime"),
  );
  writeFileSync(
    join(resourceRoot, "dependency-closure.json"),
    `${JSON.stringify(createAppDependencyClosureManifest({
      bundledAgentVersion: input.version,
      bundledAgentArtifactName: artifactName,
      bundledAgentSha256: sha256,
      releaseManifestSha256,
      updateManifestSha256,
      managedRuntimeSha256,
      backgroundServiceRegistrationMetadataSha256,
      releaseManifestsSha256: sha256Values([
        releaseManifestSha256,
        updateManifestSha256,
      ]),
      runtimePackageDependenciesSha256: sha256Values([
        sha256,
        managedRuntimeSha256,
      ]),
      repairSourceSha256: sha256Values([
        sha256,
        releaseManifestSha256,
        updateManifestSha256,
        managedRuntimeSha256,
        backgroundServiceRegistrationMetadataSha256,
      ]),
    }), null, 2)}\n`,
  );
  return resourceRoot;
}

function appPointer(version: string) {
  return {
    schema: APP_MANAGED_RUNTIME_POINTER_SCHEMA,
    product: "butler-app",
    bundled_agent_product: "butler-agent",
    bundled_agent_version: version,
    gateway_profile: "electron",
    version,
    runtime_home: join("app", "runtime", "agent", "versions", version),
    raw_text_included: false,
  } as const;
}

function writeHostToolBlockers(dir: string, _logPath: string): void {
  mkdirSync(dir, { recursive: true });
  for (const tool of ["curl", "wget", "unzip", "tar"]) {
    const path = join(dir, tool);
    writeFileSync(
      path,
      `#!/bin/sh\nprintf '%s\\n' '${tool}' >> "$BUTLER_HOST_TOOL_BLOCK_LOG"\nexit 127\n`,
      "utf8",
    );
    chmodSync(path, 0o755);
  }
}

function fixedNow(): Date {
  return new Date("2026-06-12T00:00:00.000Z");
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeReadyRuntime(butlerData: string, runtimeLabel: string): void {
  mkdirSync(join(butlerData, runtimeLabel, "bin"), { recursive: true });
  mkdirSync(
    join(butlerData, runtimeLabel, "packages", "butler-agent", "resources", "runtime"),
    { recursive: true },
  );
  writeFileSync(join(butlerData, runtimeLabel, "bin", "butler.js"), "");
  writeFileSync(
    join(
      butlerData,
      runtimeLabel,
      "packages",
      "butler-agent",
      "resources",
      "runtime",
      "bun-version",
    ),
    "1.3.11\n",
  );
  const runtimePayloadHome = join(
    butlerData,
    runtimeLabel,
    "packages",
    "butler-agent",
    "resources",
    "runtime",
  );
  if (process.platform === "win32") {
    writeWindowsRuntimeFixture(runtimePayloadHome);
  } else {
    mkdirSync(join(runtimePayloadHome, "bin"), { recursive: true });
    writeFileSync(join(runtimePayloadHome, "bin", "bun"), "#!/bin/sh\n", {
      mode: 0o755,
    });
  }
}

function writeWindowsRuntimeFixture(runtimePayloadHome: string): void {
  const bin = join(runtimePayloadHome, "bin");
  const bun = join(bin, "bun.exe");
  const processHost = join(bin, "butler-process-host.exe");
  mkdirSync(bin, { recursive: true });
  copyFileSync(process.execPath, bun);
  copyFileSync(process.execPath, processHost);
  const thumbprint = "A".repeat(40);
  writeFileSync(
    join(runtimePayloadHome, "windows-signatures.json"),
    `${JSON.stringify({
      schema: "butler.windows-runtime-signatures.v1",
      verification: "authenticode-powershell-5.1",
      files: [
        {
          path: "bin/bun.exe",
          sha256: sha256File(bun),
          status: "Valid",
          signerThumbprint: thumbprint,
          signerSubject: "CN=Butler Windows Runtime Fixture",
        },
        {
          path: "bin/butler-process-host.exe",
          sha256: sha256File(processHost),
          status: "Valid",
          signerThumbprint: thumbprint,
          signerSubject: "CN=Butler Windows Runtime Fixture",
        },
      ],
      rawTextIncluded: false,
    }, null, 2)}\n`,
  );
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256TextForTest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Directory(path: string): string {
  const hash = createHash("sha256");
  for (const file of listFiles(path)) {
    const label = file.slice(path.length + 1).replace(/\\/g, "/");
    hash.update(label);
    hash.update("\0");
    hash.update(sha256File(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function listFiles(path: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(path).sort()) {
    const fullPath = join(path, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) result.push(...listFiles(fullPath));
    else if (stat.isFile()) result.push(fullPath);
  }
  return result;
}

function sha256Values(values: string[]): string {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(value);
    hash.update("\0");
  }
  return hash.digest("hex");
}
