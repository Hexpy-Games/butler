import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";
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

test("App-managed runtime activation does not shell out to host tar", () => {
  const source = readFileSync(
    join(root, "packages", "butler-app", "client", "electron", "app-managed-runtime.mjs"),
    "utf8",
  );
  expect(source).not.toContain("node:child_process");
  expect(source).not.toContain('spawnSync("tar"');
  expect(source).not.toContain('"tar", ["-xzf"');
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
      resolveRuntime: () => "/managed/bun",
    });

    expect(command).not.toBeNull();
    if (!command) throw new Error("expected app-managed gateway command");
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
      BUTLER_BUN: "/managed/bun",
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
  input: { version: string; sha256?: string; symlink?: boolean },
): string {
  const resourceRoot = join(root, `resource-${input.version}`);
  const stageRoot = join(root, `stage-${input.version}`);
  const artifactName = `butler-agent-${input.version}-all.tar.gz`;
  mkdirSync(join(stageRoot, "bin"), { recursive: true });
  mkdirSync(join(stageRoot, "packages", "butler-agent", "resources", "runtime"), {
    recursive: true,
  });
  writeFileSync(join(stageRoot, "bin", "butler.js"), "#!/usr/bin/env node\n");
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
          integrity: {
            digestAlgorithm: "sha256",
            digest: sha256,
            signature: null,
          },
        },
      ],
    }, null, 2)}\n`,
  );
  return resourceRoot;
}

function fixedNow(): Date {
  return new Date("2026-06-12T00:00:00.000Z");
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
