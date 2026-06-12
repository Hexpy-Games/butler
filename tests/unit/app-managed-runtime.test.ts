import { createHash } from "node:crypto";
import {
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
  APP_MANAGED_RUNTIME_POINTER_SCHEMA,
  activateAppManagedAgentRuntime,
  appManagedAgentPointerPath,
  prepareAppManagedAgentRuntime,
  resolveAppManagedGatewayCommand,
} from "../../packages/butler-app/client/electron/app-managed-runtime.mjs";

const root = process.cwd();

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
    const resourceRoot = createBundledAgentResource(tempDir, {
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
    expect(existsSync(join(butlerData, "runtime", "agent", "current.json"))).toBe(false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App-managed runtime preparation flips pointer only after readiness commit", () => {
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

test("App-managed runtime rejects unsafe bundled Agent archive entries", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-runtime-unsafe-"));
  try {
    const resourceRoot = createBundledAgentResource(tempDir, {
      version: "4.0.0",
      symlink: true,
    });
    expect(() =>
      activateAppManagedAgentRuntime({
        butlerData: join(tempDir, "data"),
        resourceRoot,
        now: fixedNow,
      }),
    ).toThrow("unsafe entry type");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

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
        butlerData: join(tempDir, "data"),
        resourceRoot,
        now: fixedNow,
      }),
    ).toThrow("managed-runtime-payload digest mismatch");
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
          "bun",
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
    join(root, "packages", "butler-app", "client", "electron", "app-managed-runtime.mjs"),
    "utf8",
  );
  expect(source).not.toContain("node:child_process");
  expect(source).not.toContain('spawnSync("tar"');
  expect(source).not.toContain('"tar", ["-xzf"');
  expect(source).not.toContain("npm install");
  expect(source).not.toContain("brew install");
  expect(source).not.toContain("apt install");
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
      "bun",
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

function createBundledAgentResource(
  root: string,
  input: {
    version: string;
    sha256?: string;
    symlink?: boolean;
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
  writeFileSync(join(stageRoot, "packages", "butler-agent", "owned-file.txt"), "owned\n");
  writeFileSync(
    join(stageRoot, "packages", "butler-agent", "resources", "runtime", "bun-version"),
    "1.3.11\n",
  );
  if (input.symlink) {
    const link = spawnSync("ln", ["-s", "bin/butler.js", join(stageRoot, "unsafe-link")], {
      encoding: "utf8",
    });
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
  mkdirSync(join(resourceRoot, "runtime", "bin"), { recursive: true });
  writeFileSync(join(resourceRoot, "runtime", "bin", "bun"), "#!/bin/sh\n", {
    mode: 0o755,
  });
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
      ]),
    }), null, 2)}\n`,
  );
  return resourceRoot;
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
  mkdirSync(
    join(butlerData, runtimeLabel, "packages", "butler-agent", "resources", "runtime", "bin"),
    { recursive: true },
  );
  writeFileSync(
    join(
      butlerData,
      runtimeLabel,
      "packages",
      "butler-agent",
      "resources",
      "runtime",
      "bin",
      "bun",
    ),
    "#!/bin/sh\n",
    { mode: 0o755 },
  );
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
