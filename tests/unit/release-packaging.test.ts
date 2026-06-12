import { expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createReleaseManifest as createServiceReleaseManifest,
  SERVICE_APP_WEB_CLIENT_DIST,
  serviceCliLauncherRelativePath,
  validateReleaseManifest as validateServiceReleaseManifest,
} from "../../packages/butler-agent/src/operations/release/manifest.ts";
import {
  createServiceReleasePackage,
  currentServiceCliLauncherPlatform,
} from "../../packages/butler-agent/src/operations/release/package-service-release.ts";
import {
  APP_RELEASE_PLATFORMS,
  createAppReleaseManifest,
  validateAppReleaseManifest,
} from "../../packages/butler-app/scripts/release/manifest.ts";
import {
  appReleaseIconPath,
  appReleasePackagerIconPath,
} from "../../packages/butler-app/scripts/release/package-app-release.ts";

const root = process.cwd();
const currentVersion = String(
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "",
);
const currentReleaseTag = `v${currentVersion}`;

test("service release manifest exposes Butler CLI entrypoint and service files only", () => {
  const manifest = createServiceReleaseManifest(root);

  expect(manifest).toMatchObject({
    name: "butler",
    product: "butler-agent",
    publicProductGroups: ["butler-agent"],
    profile: "agent-standalone",
    canonicalComponent: "agent",
    legacyComponentAliases: ["service"],
    version: currentVersion,
    protocolCompatibility: {
      protocol: "butler.agent.v1",
      minimumAgentProtocol: "butler.agent.v1",
      maximumAgentProtocol: "butler.agent.v1",
    },
    bin: {
      butler: "./bin/butler.js",
    },
  });
  expect(manifest.components.map((component) => component.id)).toEqual([
    "service",
  ]);
  expect(
    manifest.components.every((component) => component.version === currentVersion),
  ).toBe(true);
  expect(
    manifest.components.find((component) => component.id === "service")
      ?.bundledComponents,
  ).toEqual(["service"]);
  expect(
    manifest.components.find((component) => component.id === "service"),
  ).toMatchObject({
    product: "butler-agent",
    canonicalComponent: "agent",
    legacyAliases: ["service"],
    profile: "agent-standalone",
    protocolCompatibility: {
      protocol: "butler.agent.v1",
      minimumAgentProtocol: "butler.agent.v1",
      maximumAgentProtocol: "butler.agent.v1",
    },
    updatePolicy: "explicit",
    restartPolicy: "restart-service",
    updaterOwner: "butler-agent",
    payloadFormat: "agent-archive",
    stagingPolicy: "butler-data-updates",
    activationPolicy: "versioned-standalone-runtime",
    rollbackPolicy: "preserve-previous-standalone-runtime",
  });
  expect(manifest.artifacts[0]).toMatchObject({
    product: "butler-agent",
    canonicalComponent: "agent",
    profile: "agent-standalone",
    protocolCompatibility: {
      protocol: "butler.agent.v1",
      minimumAgentProtocol: "butler.agent.v1",
      maximumAgentProtocol: "butler.agent.v1",
    },
    integrity: {
      digestAlgorithm: "sha256",
      digest: null,
      signature: null,
    },
    updaterOwner: "butler-agent",
    payloadFormat: "agent-archive",
    stagingPolicy: "butler-data-updates",
    activationPolicy: "versioned-standalone-runtime",
    rollbackPolicy: "preserve-previous-standalone-runtime",
  });
  expect(manifest.cliLaunchers.map((launcher) => launcher.platform)).toEqual([
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
  ]);
  expect(manifest.cliLaunchers.map((launcher) => launcher.path)).toContain(
    "packages/butler-agent/resources/cli/darwin-arm64/butler",
  );
  expect(manifest.appWebClientDist).toBe(SERVICE_APP_WEB_CLIENT_DIST);
  expect(manifest.requiredFiles).toContain(
    "packages/butler-agent/src/gateways",
  );
  expect(manifest.requiredFiles).toContain("bin/butler.js");
  expect(manifest.requiredFiles).toContain("package.json");
  expect(manifest.requiredFiles).toContain("packages/butler-agent/scripts");
  expect(manifest.requiredFiles).toContain("packages/butler-agent/resources");
  expect(manifest.requiredFiles).toContain("packages/project-ledger");
  expect(
    manifest.components.flatMap((component) => component.requiredFiles),
  ).not.toContain("packages/butler-app/client/electron/package.json");
  expect(validateServiceReleaseManifest(root, manifest)).toEqual([]);
  for (const file of manifest.requiredFiles) {
    expect(existsSync(join(root, file))).toBe(true);
  }
});

test("app release manifest exposes app package files only", () => {
  const manifest = createAppReleaseManifest(root);

  expect(manifest).toMatchObject({
    name: "butler-app",
    product: "butler-app",
    publicProductGroups: ["butler-app"],
    protocol: "butler.app.v1",
    protocolCompatibility: {
      protocol: "butler.app.v1",
      minimumAppProtocol: "butler.app.v1",
      maximumAppProtocol: "butler.app.v1",
    },
    gatewayProfile: "electron",
    bundledAgentVersion: currentVersion,
    updaterOwner: "butler-app",
    version: currentVersion,
  });
  expect(manifest.components.map((component) => component.id)).toEqual(["app"]);
  expect(
    manifest.components.every((component) => component.version === currentVersion),
  ).toBe(true);
  expect(
    manifest.components.find((component) => component.id === "app")
      ?.bundledComponents,
  ).toEqual(["app"]);
  expect(manifest.components.find((component) => component.id === "app")).toMatchObject({
    product: "butler-app",
    gatewayProfile: "electron",
    bundledAgentVersion: currentVersion,
    protocolCompatibility: {
      protocol: "butler.app.v1",
      minimumAppProtocol: "butler.app.v1",
      maximumAppProtocol: "butler.app.v1",
    },
    updatePolicy: "app-user-action",
    restartPolicy: "restart-app",
    updaterOwner: "butler-app",
    payloadFormat: "platform-app-package",
    stagingPolicy: "platform-updater-cache",
    activationPolicy: "platform-app-update-then-versioned-app-runtime",
    rollbackPolicy: "preserve-previous-app-managed-runtime",
  });
  expect(manifest.artifacts[0]).toMatchObject({
    product: "butler-app",
    gatewayProfile: "electron",
    bundledAgentVersion: currentVersion,
    protocolCompatibility: {
      protocol: "butler.app.v1",
      minimumAppProtocol: "butler.app.v1",
      maximumAppProtocol: "butler.app.v1",
    },
    integrity: {
      digestAlgorithm: "sha256",
      digest: null,
      signature: null,
    },
    updaterOwner: "butler-app",
    payloadFormat: "platform-app-package",
    stagingPolicy: "platform-updater-cache",
    activationPolicy: "platform-app-update-then-versioned-app-runtime",
    rollbackPolicy: "preserve-previous-app-managed-runtime",
  });
  const appReleasePaths = manifest.components.flatMap(
    (component) => component.requiredFiles,
  );
  expect(appReleasePaths).toContain(
    "packages/butler-app/client/electron/package.json",
  );
  expect(appReleasePaths).toContain(
    "packages/butler-app/client/electron/scripts",
  );
  expect(appReleasePaths).toContain(
    "packages/butler-app/client/electron/assets/icon.png",
  );
  expect(appReleasePaths).toContain(
    "packages/butler-app/client/electron/assets/butler.icon",
  );
  expect(appReleasePaths).toContain(
    "packages/butler-app/client/electron/assets/butler.icns",
  );
  expect(appReleasePaths).toContain(
    "packages/butler-app/client/electron/assets/butler-mac.png",
  );
  expect(appReleasePaths).toContain(
    "packages/butler-app/client/electron/assets/butler-mark-flat.png",
  );
  expect(appReleasePaths).toContain(
    "packages/butler-app/client/electron/assets/butler-mark-flat-white.png",
  );
  expect(appReleasePaths).toContain("packages/butler-app/client/ui/src");
  expect(appReleasePaths).not.toContain("bin/butler.js");
  expect(
    appReleasePaths.some((file) => file.startsWith("packages/butler-agent/")),
  ).toBe(false);
  expect(manifest.artifacts.map((artifact) => artifact.platform)).toEqual([
    ...APP_RELEASE_PLATFORMS,
  ]);
  expect(manifest.artifacts.map((artifact) => artifact.artifactName)).toEqual([
    `butler-app-${currentVersion}-darwin-arm64.zip`,
    `butler-app-${currentVersion}-linux-x64.tar.gz`,
  ]);
  expect(validateAppReleaseManifest(root, manifest)).toEqual([]);
});

test("release manifest validation rejects missing two-product schema fields", () => {
  const brokenAgent = structuredClone(createServiceReleaseManifest(root));
  brokenAgent.product = "service" as any;
  brokenAgent.profile = "service" as any;
  brokenAgent.publicProductGroups = ["butler-agent", "service"] as any;
  brokenAgent.protocolCompatibility = undefined as any;
  brokenAgent.artifacts = brokenAgent.artifacts.map((artifact) => ({
    ...artifact,
    product: "service" as any,
    profile: "service" as any,
    integrity: undefined as any,
    stagingPolicy: "shell-download" as any,
  }));
  expect(validateServiceReleaseManifest(root, brokenAgent)).toEqual(
    expect.arrayContaining([
      "release product must be butler-agent",
      "release public product groups must contain only butler-agent",
      "release profile must be agent-standalone",
      "release manifest protocol compatibility is required",
      "artifact service product must be butler-agent",
      "artifact service profile must be agent-standalone",
      "artifact service integrity metadata is required",
      "artifact service staging policy must be butler-data-updates",
    ]),
  );

  const brokenApp = structuredClone(createAppReleaseManifest(root));
  brokenApp.product = "butler-service" as any;
  brokenApp.publicProductGroups = ["butler-app", "butler-service"] as any;
  brokenApp.gatewayProfile = "terminal" as any;
  brokenApp.bundledAgentVersion = "0.0.0";
  brokenApp.protocolCompatibility = undefined as any;
  brokenApp.artifacts = brokenApp.artifacts.map((artifact) => ({
    ...artifact,
    product: "butler-service" as any,
    gatewayProfile: "terminal" as any,
    integrity: undefined as any,
    activationPolicy: "in-place" as any,
  }));
  expect(validateAppReleaseManifest(root, brokenApp)).toEqual(
    expect.arrayContaining([
      "app release product must be butler-app",
      "app release public product groups must contain only butler-app",
      "app release manifest protocol compatibility is required",
      "app release gateway profile must be electron",
      "app release bundled agent version mismatch",
      "artifact app product must be butler-app",
      "artifact app gateway profile must be electron",
      "artifact app bundled agent version mismatch",
      "artifact app integrity metadata is required",
      "artifact app activation policy must be platform-app-update-then-versioned-app-runtime",
    ]),
  );
});

test("release manifest validation rejects cross-owned bundled artifacts", () => {
  const manifest = createServiceReleaseManifest(root);
  const brokenService = structuredClone(manifest);
  brokenService.components = brokenService.components.map((component) =>
    component.id === "service"
      ? { ...component, bundledComponents: ["service", "app"] as any }
      : component,
  );
  brokenService.artifacts = brokenService.artifacts.map((artifact) =>
    artifact.component === "service"
      ? { ...artifact, bundledComponents: ["service", "app"] as any }
      : artifact,
  );
  expect(validateServiceReleaseManifest(root, brokenService)).toContain(
    "Butler Agent component must not bundle app",
  );
  expect(validateServiceReleaseManifest(root, brokenService)).toContain(
    "Butler Agent artifact must not bundle app",
  );

  const brokenApp = structuredClone(createAppReleaseManifest(root));
  brokenApp.components = brokenApp.components.map((component) =>
    component.id === "app"
      ? { ...component, bundledComponents: ["app", "service"] as any }
      : component,
  );
  expect(validateAppReleaseManifest(root, brokenApp)).toContain(
    "app component must not bundle service or gateway host",
  );
  const brokenAppPaths = structuredClone(createAppReleaseManifest(root));
  brokenAppPaths.components = brokenAppPaths.components.map((component) =>
    component.id === "app"
      ? {
          ...component,
          requiredFiles: [
            ...component.requiredFiles,
            "packages/butler-agent/src/agent/turn/native-tool-loop.ts",
          ],
        }
      : component,
  );
  expect(validateAppReleaseManifest(root, brokenAppPaths)).toContain(
    "app release required file must not include service internals: packages/butler-agent/src/agent/turn/native-tool-loop.ts",
  );
  const brokenAppPlatforms = structuredClone(createAppReleaseManifest(root));
  brokenAppPlatforms.artifacts = brokenAppPlatforms.artifacts.filter(
    (artifact) => artifact.platform !== "linux-x64",
  );
  expect(validateAppReleaseManifest(root, brokenAppPlatforms)).toContain(
    "missing app release artifact platform: app/linux-x64",
  );
});

test("service release packager creates an installable artifact with app web client", () => {
  const outDir = mkdtempSync(join(tmpdir(), "butler-service-release-test-"));
  try {
    const currentCliPlatform = currentServiceCliLauncherPlatform();
    const result = createServiceReleasePackage({
      root,
      outDir,
      cliLauncherPlatforms: [currentCliPlatform],
    });
    expect(existsSync(result.artifactPath)).toBe(true);
    expect(existsSync(result.sha256Path)).toBe(true);
    expect(existsSync(result.releaseManifestPath)).toBe(true);
    expect(existsSync(result.updateManifestPath)).toBe(true);

    const listing = spawnSync("tar", ["-tzf", result.artifactPath], {
      encoding: "utf8",
    });
    expect(listing.status).toBe(0);
    const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
    const currentCliLauncher = serviceCliLauncherRelativePath(
      currentCliPlatform,
    );
    expect(entries).toContain("./install.sh");
    expect(entries).toContain("./package.json");
    expect(entries).toContain("./bin/butler.js");
    expect(entries).toContain(`./${currentCliLauncher}`);
    expect(entries).toContain("./packages/butler-agent/scripts/service-control.sh");
    expect(entries).toContain("./packages/project-ledger/bin/project-ledger");
    expect(entries).toContain(`./${SERVICE_APP_WEB_CLIENT_DIST}/index.html`);
    expect(entries.some((entry) => entry.startsWith(`./${SERVICE_APP_WEB_CLIENT_DIST}/assets/`))).toBe(true);
    expect(entries.some((entry) => entry.includes("packages/butler-app/"))).toBe(false);
    expect(entries.some((entry) => entry.includes("/node_modules/"))).toBe(false);

    const extractDir = mkdtempSync(join(tmpdir(), "butler-service-release-extract-"));
    try {
      const extract = spawnSync("tar", ["-xzf", result.artifactPath, "-C", extractDir], {
        encoding: "utf8",
      });
      expect(extract.status).toBe(0);
      const packagedRootPackage = JSON.parse(
        readText(join(extractDir, "package.json")),
      );
      expect(packagedRootPackage.workspaces).toEqual([
        "packages/project-ledger",
        "packages/butler-agent/src/interfaces/mcp-server",
        "packages/butler-agent/src/integrations/telegram",
      ]);
      expect(JSON.stringify(packagedRootPackage)).not.toContain("packages/butler-app");
      expect(
        readText(join(extractDir, SERVICE_APP_WEB_CLIENT_DIST, "index.html")),
      ).toContain("<title>Butler</title>");
      const prebuiltHelp = spawnSync(join(extractDir, currentCliLauncher), ["--help"], {
        cwd: extractDir,
        encoding: "utf8",
        env: {
          ...process.env,
          BUTLER_HOME: extractDir,
          BUTLER_DATA: extractDir,
          BUTLER_BUN: process.execPath,
        },
      });
      expect(prebuiltHelp.status).toBe(0);
      expect(prebuiltHelp.stdout).toContain("Butler CLI");
    } finally {
      rmSync(extractDir, { recursive: true, force: true });
    }

    const updateManifest = JSON.parse(readText(result.updateManifestPath));
    const releaseManifest = JSON.parse(readText(result.releaseManifestPath));
    expect(releaseManifest.artifacts[0]).toMatchObject({
      artifactName: result.artifactName,
      downloadUrl: `file://${result.artifactPath}`,
      sha256: result.sha256,
    });
    expect(updateManifest.artifacts[0]).toMatchObject({
      component: "service",
      version: result.version,
      artifact_url: `file://${result.artifactPath}`,
      sha256: result.sha256,
      bundled_components: ["service"],
      product: "butler-agent",
      canonical_component: "agent",
      profile: "agent-standalone",
      protocol_compatibility: {
        protocol: "butler.agent.v1",
        minimumAgentProtocol: "butler.agent.v1",
        maximumAgentProtocol: "butler.agent.v1",
      },
      integrity: {
        digestAlgorithm: "sha256",
        digest: result.sha256,
        signature: null,
      },
      update_policy: "explicit",
      restart_policy: "restart-service",
      updater_owner: "butler-agent",
      payload_format: "agent-archive",
      staging_policy: "butler-data-updates",
      activation_policy: "versioned-standalone-runtime",
      rollback_policy: "preserve-previous-standalone-runtime",
    });
    expect(updateManifest.cli_launchers).toContainEqual({
      platform: currentCliPlatform,
      path: currentCliLauncher,
      build_target: `bun-${currentCliPlatform}`,
    });
    expect(updateManifest.app_web_client_dist).toBe(SERVICE_APP_WEB_CLIENT_DIST);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}, 30_000);
test("service release packager can write public GitHub artifact URLs", () => {
  const outDir = mkdtempSync(join(tmpdir(), "butler-service-release-url-test-"));
  try {
    const result = createServiceReleasePackage({
      root,
      outDir,
      artifactBaseUrl: `https://github.com/Hexpy-Games/butler/releases/download/${currentReleaseTag}/`,
      cliLauncherPlatforms: [currentServiceCliLauncherPlatform()],
    });
    const expectedUrl =
      `https://github.com/Hexpy-Games/butler/releases/download/${currentReleaseTag}/${result.artifactName}`;

    const releaseManifest = JSON.parse(readText(result.releaseManifestPath));
    const updateManifest = JSON.parse(readText(result.updateManifestPath));

    expect(releaseManifest.artifacts[0]).toMatchObject({
      downloadUrl: expectedUrl,
      sha256: result.sha256,
    });
    expect(updateManifest.artifacts[0]).toMatchObject({
      artifact_url: expectedUrl,
      sha256: result.sha256,
    });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}, 30_000);

test("Butler CLI help documents install home and data overrides", () => {
  const result = spawnSync("node", [join(root, "bin", "butler.js"), "--help"], {
    cwd: root,
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("butler install [--home PATH] [--data PATH]");
  expect(result.stdout).toContain("BUTLER_HOME: ~/butler");
  expect(result.stdout).toContain("BUTLER_DATA: ~/.butler");
});

test("package-owned release gate scripts pass in the repo checkout", () => {
  const defaultEnv = { ...process.env };
  delete defaultEnv.BUTLER_VALIDATE_VERBOSE;
  defaultEnv.BUTLER_HOME = join(root, ".stale-butler-home");
  const service = spawnSync(
    "bun",
    ["run", "packages/butler-agent/src/operations/release/release-gate.ts"],
    {
      cwd: root,
      encoding: "utf8",
      env: defaultEnv,
    },
  );
  const serviceVerbose = spawnSync(
    "bun",
    [
      "run",
      "packages/butler-agent/src/operations/release/release-gate.ts",
      "--verbose",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: defaultEnv,
    },
  );
  const app = spawnSync(
    "bun",
    ["run", "packages/butler-app/scripts/release/release-gate.ts"],
    {
      cwd: root,
      encoding: "utf8",
      env: defaultEnv,
    },
  );
  const appVerbose = spawnSync(
    "bun",
    ["run", "packages/butler-app/scripts/release/release-gate.ts", "--verbose"],
    {
      cwd: root,
      encoding: "utf8",
      env: defaultEnv,
    },
  );
  const rootGate = spawnSync("bun", ["run", "release:gate"], {
    cwd: root,
    encoding: "utf8",
    env: defaultEnv,
  });

  expect(service.status).toBe(0);
  expect(service.stdout).toBe("");
  expect(serviceVerbose.status).toBe(0);
  expect(serviceVerbose.stdout).toContain(
    `Butler Agent release gate passed: butler@${currentVersion}`,
  );
  expect(serviceVerbose.stdout).toContain(`Products: Butler Agent@${currentVersion}`);
  expect(app.status).toBe(0);
  expect(app.stdout).toBe("");
  expect(appVerbose.status).toBe(0);
  expect(appVerbose.stdout).toContain(
    `App release gate passed: butler-app@${currentVersion}`,
  );
  expect(appVerbose.stdout).toContain(`Components: app@${currentVersion}`);
  expect(rootGate.status).toBe(0);
  expect(rootGate.stdout).toBe("");
});

test("dedicated client package smoke and metadata are available", () => {
  const rootPackage = JSON.parse(readText(join(root, "package.json")));
  const electronPackage = JSON.parse(
    readText(
      join(
        root,
        "packages",
        "butler-app",
        "client",
        "electron",
        "package.json",
      ),
    ),
  );

  expect(rootPackage.scripts).toHaveProperty("app:package:smoke");
  expect(rootPackage.scripts).toHaveProperty("app:layout:smoke");
  expect(rootPackage.scripts).toHaveProperty("release:service:package");
  expect(rootPackage.scripts).toHaveProperty("release:app:package");
  expect(rootPackage.scripts["release:app:package"]).toContain(
    "packages/butler-app/scripts/release/package-app-release.ts",
  );
  expect(rootPackage.scripts).toHaveProperty("install:docker");
  expect(electronPackage.scripts).toHaveProperty("package:mac");
  expect(electronPackage.scripts).toHaveProperty("package:linux");
  expect(electronPackage.scripts["package:mac"]).toContain(
    "adhoc-sign-mac.mjs",
  );
  expect(electronPackage.scripts["package:mac"]).toContain(
    "normalize-mac-bundle.mjs",
  );
  expect(electronPackage.scripts["package:mac"]).toContain(
    "--app-bundle-id=com.hexpy.butler",
  );
  expect(electronPackage.scripts["package:mac"]).toContain(
    "--ignore=\"^/dist($|/)\"",
  );
  expect(electronPackage.scripts["package:linux"]).toContain(
    "--ignore=\"^/dist($|/)\"",
  );
  expect(electronPackage.version).toBe(currentVersion);
  expect(electronPackage.devDependencies).toHaveProperty("@electron/packager");
  expect(
    readText(
      join(
        root,
        "packages",
        "butler-agent",
        "src",
        "gateways",
        "app",
        "VERSION",
      ),
    ).trim(),
  ).toBe(currentVersion);
  expect(existsSync(join(root, "tests", "smoke", "app-package-smoke.ts"))).toBe(
    true,
  );
  expect(existsSync(join(root, "tests", "smoke", "app-layout-smoke.ts"))).toBe(
    true,
  );
  expect(
    readText(join(root, "tests", "smoke", "app-package-smoke.ts")),
  ).toContain("electron-packager");
  expect(
    readText(join(root, "tests", "smoke", "app-package-smoke.ts")),
  ).toContain("packaged app executable");
  const appReleasePackager = readText(
    join(root, "packages", "butler-app", "scripts", "release", "package-app-release.ts"),
  );
  expect(appReleasePackager).toContain("butler.update-manifest.v1");
  expect(appReleasePackager).toContain("app-release-manifest.json");
  expect(appReleasePackager).toContain("app-update-manifest.json");
  expect(appReleasePackager).toContain("adhoc-sign-mac.mjs");
  expect(appReleasePackager).toContain("normalize-mac-bundle.mjs");
  expect(appReleasePackager).toContain("BUTLER_APP_PACKAGER");
  expect(appReleasePackager).toContain("appReleaseIconPath(root)");
  expect(appReleasePackager).toContain("appReleasePackagerIconPath(outDir)");
  expect(appReleasePackager).toContain("copyFileSync(iconPath, packagerIconPath)");
  expect(appReleasePackager).toContain("CFBundleIconName");
  expect(appReleasePackager).toContain("--app-bundle-id=");
  expect(appReleasePackager).toContain("packaged mac app icon does not match Butler icon");
  expect(appReleasePackager).toContain("--ignore=^/dist($|/)");
  expect(appReleaseIconPath(root)).toBe(
    join(root, "packages", "butler-app", "client", "electron", "assets", "butler.icns"),
  );
  expect(appReleasePackagerIconPath(join(root, "dist", "release"))).toBe(
    join(root, "dist", "release", "butler-release-icon.icns"),
  );
  expect(
    readText(
      join(root, "packages", "butler-app", "scripts", "app-client-managed-server-smoke.ts"),
    ),
  ).toContain("BUTLER_BUN: process.execPath");
  expect(readText(join(root, "install.sh"))).not.toContain("v1.0.0");
  expect(readText(join(root, "install.sh"))).toContain("$BUTLER_HOME/VERSION");
  expect(electronPackage).toMatchObject({
    productName: "Butler",
    butler: {
      protocolVersion: "butler.app.v1",
      icon: "assets/butler.icns",
      serverMode: "agent-gateway",
    },
  });
  expect(
    existsSync(
      join(
        root,
        "packages",
        "butler-app",
        "client",
        "electron",
        "assets",
        "butler.icns",
      ),
    ),
  ).toBe(true);
});

function readText(path: string): string {
  return readFileSync(path, "utf8");
}
