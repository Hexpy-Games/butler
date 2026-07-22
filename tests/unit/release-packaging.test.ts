import { expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { extract as extractTarArchive, list as listTarArchive } from "tar";
import {
  createReleaseManifest as createServiceReleaseManifest,
  SERVICE_CLI_LAUNCHER_PLATFORMS,
  SERVICE_APP_WEB_CLIENT_DIST,
  serviceCliLauncherRelativePath,
  validateReleaseManifest as validateServiceReleaseManifest,
} from "../../packages/butler-agent/src/operations/release/manifest.ts";
import {
  createServiceReleasePackage,
  currentServiceCliLauncherPlatform,
} from "../../packages/butler-agent/src/operations/release/package-service-release.ts";
import {
  APP_RELEASE_BUILD_PLATFORMS,
  APP_RELEASE_PLATFORMS,
  createAppReleaseManifest,
  validateAppDependencyClosureManifest,
  validateAppReleaseManifest,
  validateAppReleaseVersionCoupling,
} from "../../packages/butler-app/scripts/release/manifest.ts";
import {
  appReleaseIconPath,
  appReleasePackagerIconPath,
  isWindowsX64Pe,
  createAppReleasePackage,
  prepareBundledAgentResource,
  prepareBundledAgentResourceFromPackage,
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
    artifactLayout: {
      executable: "bin/butler.js",
      runtimeResolver: "packages/butler-agent/scripts/start-butler.sh",
      configTemplates: ["butler.config.template.json"],
      serviceTemplates: [
        "deploy/agent/templates/launchd.plist.template",
        "deploy/agent/templates/systemd.service.template",
      ],
    },
    operatorCommands: ["init", "start", "status", "stop", "doctor"],
    operatorCommandMap: {
      init: ["butler", "install"],
      start: ["butler", "start"],
      status: ["butler", "status"],
      stop: ["butler", "stop"],
      doctor: ["butler", "doctor"],
    },
    desktopCompanion: {
      defaultMode: "headless",
      autoRegister: false,
      optInCommand: null,
    },
  });
  expect(JSON.stringify(manifest)).not.toContain("--butler-menu-bar-helper");
  expect(JSON.stringify(manifest)).not.toContain("app-desktop-helper");
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
    "windows-x64",
  ]);
  expect(manifest.cliLaunchers.map((launcher) => launcher.path)).toContain(
    "packages/butler-agent/resources/cli/darwin-arm64/butler",
  );
  expect(manifest.appWebClientDist).toBe(SERVICE_APP_WEB_CLIENT_DIST);
  expect(manifest.requiredFiles).toContain("packages/butler-agent/src");
  expect(manifest.requiredFiles).not.toContain(
    "packages/butler-agent/src/gateways",
  );
  expect(manifest.requiredFiles).toContain("bin/butler.js");
  expect(manifest.requiredFiles).toContain("package.json");
  expect(manifest.requiredFiles).toContain("packages/butler-agent/scripts");
  expect(manifest.requiredFiles).toContain("packages/butler-agent/resources");
  expect(manifest.requiredFiles).toContain("packages/butler-progress-projection");
  expect(manifest.requiredFiles).toContain("packages/project-ledger");
  expect(manifest.requiredFiles).toContain("deploy/agent/templates");
  expect(manifest.agentArtifactLayout).toMatchObject({
    executable: "bin/butler.js",
    runtimeResolver: "packages/butler-agent/scripts/start-butler.sh",
    configTemplates: ["butler.config.template.json"],
    serviceTemplates: [
      "deploy/agent/templates/launchd.plist.template",
      "deploy/agent/templates/systemd.service.template",
    ],
    manifestPath: "agent-release-manifest.json",
  });
  expect(manifest.operatorCommands).toEqual([
    "init",
    "start",
    "status",
    "stop",
    "doctor",
  ]);
  expect(manifest.operatorCommandMap.init).toEqual(["butler", "install"]);
  expect(manifest.operatorCommandMap.doctor).toEqual(["butler", "doctor"]);
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
    serviceInstallerBundle: {
      schema: "butler.app-service-installer-bundle.v1",
      resourcePath: "bundled-agent/service-installer/installer-manifest.json",
      installerRootPath: "bundled-agent/service-installer",
      hostToolsRequiredForFirstLaunch: [],
      rawTemplateIncluded: false,
      rawTextIncluded: false,
    },
    desktopHelper: {
      schema: "butler.app-desktop-helper.v1",
      product: "butler-app",
      owner: "butler-app",
      helperMode: "electron-main-tray",
      defaultEnabledPlatforms: [],
      survivesMainUiQuitPlatforms: [],
      stopsAgentOnHelperQuit: false,
      launchArgument: "--butler-menu-bar-helper",
      quitMainUiArgument: "--butler-quit-main-ui",
      quitHelperArgument: "--butler-quit-menu-bar-helper",
      platforms: ["darwin", "linux"],
      rawTextIncluded: false,
    },
    backgroundServiceCapability: {
      schema: "butler.app-background-service-capability.v1",
      serviceCapable: true,
      gatewayProfile: "electron",
      serviceOwner: "butler-agent",
      processGroupOwner: "native-service-supervisor",
      appGatewayOwner: "background-agent-service",
      runtimePointerPath: "$BUTLER_DATA/app/runtime/agent/current.json",
      installerRequirements: [
        {
          platform: "darwin",
          selectedV1Path: "macos-app-foreground",
          installerRequired: "no",
          packageFormats: ["dmg", "zip"],
          registersUserService: false,
        },
        {
          platform: "linux",
          selectedV1Path: "linux-app-foreground",
          installerRequired: "no",
          packageFormats: ["deb", "pacman"],
          registersUserService: false,
        },
      ],
      rawTextIncluded: false,
    },
  });
  expect(manifest.components.map((component) => component.id)).toEqual(["app"]);
  expect(
    manifest.components.every((component) => component.version === currentVersion),
  ).toBe(true);
  expect(
    manifest.components.find((component) => component.id === "app")
      ?.bundledComponents,
  ).toEqual(["app"]);
  expect(manifest.backgroundServiceCapability.requiredRuntimeFields).toContain(
    "BUTLER_APP_MANAGED_RUNTIME_POINTER",
  );
  expect(manifest.backgroundServiceCapability.serviceStatuses).toContain("ready");
  expect(manifest.backgroundServiceCapability.updateStatuses).toContain("rollback");
  expect(manifest.components.find((component) => component.id === "app")).toMatchObject({
    product: "butler-app",
    gatewayProfile: "electron",
    bundledAgentVersion: currentVersion,
    backgroundServiceCapability: {
      serviceCapable: true,
      gatewayProfile: "electron",
      appGatewayOwner: "background-agent-service",
    },
    serviceInstallerBundle: {
      servicePlatforms: ["darwin", "linux"],
      packageArtifacts: [],
    },
    desktopHelper: {
      helperMode: "electron-main-tray",
      defaultEnabledPlatforms: [],
      survivesMainUiQuitPlatforms: [],
      stopsAgentOnHelperQuit: false,
      platforms: ["darwin", "linux"],
    },
    bundledAgentPayload: {
      product: "butler-agent",
      profile: "agent-standalone",
      version: currentVersion,
      artifactName: `butler-agent-${currentVersion}-all.tar.gz`,
      resourcePath: `bundled-agent/butler-agent-${currentVersion}-all.tar.gz`,
      releaseManifestPath: "bundled-agent/agent-release-manifest.json",
      updateManifestPath: "bundled-agent/agent-update-manifest.json",
      runtimeResolver: "packages/butler-agent/scripts/start-butler.sh",
      runtimePayload: "packages/butler-agent",
      managedRuntimePayloadPath: "bundled-agent/runtime",
      dependencyClosureManifestPath: "bundled-agent/dependency-closure.json",
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
    },
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
    backgroundServiceCapability: {
      serviceCapable: true,
      gatewayProfile: "electron",
      appGatewayOwner: "background-agent-service",
    },
    serviceInstallerBundle: {
      servicePlatforms: ["darwin"],
      packageArtifacts: [],
    },
    desktopHelper: {
      helperMode: "electron-main-tray",
      platforms: ["darwin"],
      defaultEnabledPlatforms: [],
      survivesMainUiQuitPlatforms: [],
      stopsAgentOnHelperQuit: false,
    },
    bundledAgentPayload: {
      product: "butler-agent",
      version: currentVersion,
      artifactName: `butler-agent-${currentVersion}-darwin-arm64.tar.gz`,
      resourcePath: `bundled-agent/butler-agent-${currentVersion}-darwin-arm64.tar.gz`,
      integrity: {
        digestAlgorithm: "sha256",
        digest: null,
        signature: null,
      },
    },
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
  expect(
    manifest.artifacts.find((artifact) => artifact.platform === "linux-x64"),
  ).toMatchObject({
    desktopHelper: {
      helperMode: "electron-main-tray",
      platforms: ["linux"],
      defaultEnabledPlatforms: [],
      survivesMainUiQuitPlatforms: [],
      stopsAgentOnHelperQuit: false,
    },
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
    "packages/butler-app/client/electron/assets/butler.ico",
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
    `butler-app-${currentVersion}-darwin-arm64.dmg`,
    `butler-app-${currentVersion}-linux-x64.deb`,
    `butler-app-${currentVersion}-linux-arm64.deb`,
  ]);
  expect(validateAppReleaseManifest(root, manifest)).toEqual([]);
});

test("Windows app release artifacts are buildable but remain gated", () => {
  expect(APP_RELEASE_BUILD_PLATFORMS).toContain("win32-x64");
  expect(APP_RELEASE_PLATFORMS).not.toContain("win32-x64" as never);

  const manifest = createAppReleaseManifest(root, ["win32-x64"]);
  expect(manifest.artifacts).toHaveLength(1);
  expect(manifest.artifacts[0]).toMatchObject({
    platform: "win32-x64",
    artifactName: `butler-app-${currentVersion}-win32-x64-setup.exe`,
    distributionStatus: "gated",
    updateFeed: null,
    backgroundServiceCapability: {
      installerRequirements: [{
        platform: "win32",
        selectedV1Path: "windows-app-foreground",
        installerRequired: "no",
        registersUserService: false,
      }],
    },
  });
  expect(
    validateAppReleaseManifest(root, manifest, {
      expectedPlatforms: ["win32-x64"],
    }),
  ).toEqual([]);
  expect(validateAppReleaseManifest(root, manifest)).toContain(
    "unexpected app release artifact platform: win32-x64",
  );
});

test("Windows managed runtime validation accepts only x64 PE images", () => {
  const x64 = Buffer.alloc(256);
  x64.write("MZ", 0, "ascii");
  x64.writeUInt32LE(0x80, 0x3c);
  x64.write("PE\0\0", 0x80, "binary");
  x64.writeUInt16LE(0x8664, 0x84);
  expect(isWindowsX64Pe(x64)).toBe(true);

  const x86 = Buffer.from(x64);
  x86.writeUInt16LE(0x014c, 0x84);
  expect(isWindowsX64Pe(x86)).toBe(false);
  expect(isWindowsX64Pe(Buffer.from("not-a-pe"))).toBe(false);
});

test("app release manifest validation enforces bundled Agent version coupling", () => {
  const current = createAppReleaseManifest(root);

  expect(
    validateAppReleaseVersionCoupling(current, {
      version: current.version,
      bundledAgentVersion: "0.0.0",
    }),
  ).toEqual(["app release version must change when bundled Agent version changes"]);
  expect(
    validateAppReleaseManifest(root, current, {
      previousManifest: {
        version: current.version,
        bundledAgentVersion: "0.0.0",
      },
    }),
  ).toContain("app release version must change when bundled Agent version changes");
  expect(
    validateAppReleaseVersionCoupling(current, {
      version: "0.0.0",
      bundledAgentVersion: "0.0.0",
    }),
  ).toEqual([]);
  expect(
    validateAppReleaseVersionCoupling(current, {
      version: "0.0.0",
      bundledAgentVersion: current.bundledAgentVersion,
    }),
  ).toEqual([]);
  expect(validateAppReleaseVersionCoupling(current, { version: "0.0.0" })).toEqual([]);
  expect(validateAppReleaseVersionCoupling(current, { version: current.version })).toEqual([
    "app release version must change when previous bundled Agent version is unavailable",
  ]);
  expect(validateAppReleaseVersionCoupling({ version: current.version }, current)).toEqual([
    "app release version coupling requires app version and bundled Agent version",
  ]);
});

test("app release gate rejects unchanged App version when bundled Agent changes", () => {
  const workDir = mkdtempSync(join(tmpdir(), "butler-app-version-coupling-"));
  try {
    const previousManifestPath = join(workDir, "previous-app-release-manifest.json");
    writeFileSync(
      previousManifestPath,
      JSON.stringify({
        version: currentVersion,
        bundledAgentVersion: "0.0.0",
      }),
    );
    const result = spawnSync("bun", [
      "run",
      "--silent",
      "packages/butler-app/scripts/release/release-gate.ts",
      "--previous-manifest",
      previousManifestPath,
    ], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "app release version must change when bundled Agent version changes",
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("app release metadata ships bundled-Agent-only changes as a new App artifact", () => {
  const manifest = createAppReleaseManifest(root);
  const previousBundledAgentOnlyBaseline = {
    version: "0.0.0",
    bundledAgentVersion: "0.0.0",
  };

  expect(
    validateAppReleaseVersionCoupling(manifest, previousBundledAgentOnlyBaseline),
  ).toEqual([]);
  expect(
    validateAppReleaseVersionCoupling(manifest, {
      version: manifest.version,
      bundledAgentVersion: previousBundledAgentOnlyBaseline.bundledAgentVersion,
    }),
  ).toEqual(["app release version must change when bundled Agent version changes"]);
  expect(manifest.components.map((component) => component.id)).toEqual(["app"]);
  for (const artifact of manifest.artifacts) {
    expect(artifact).toMatchObject({
      product: "butler-app",
      component: "app",
      version: manifest.version,
      bundledAgentVersion: manifest.bundledAgentVersion,
      bundledComponents: ["app"],
      updaterOwner: "butler-app",
      payloadFormat: "platform-app-package",
      activationPolicy: "platform-app-update-then-versioned-app-runtime",
      rollbackPolicy: "preserve-previous-app-managed-runtime",
      backgroundServiceCapability: {
        serviceCapable: true,
        appGatewayOwner: "background-agent-service",
      },
    });
    expect(artifact.artifactName).toContain(`butler-app-${manifest.version}-`);
    expect(artifact.bundledAgentPayload.version).toBe(manifest.bundledAgentVersion);
    expect(artifact.bundledAgentPayload.resourcePath).toBe(
      `bundled-agent/butler-agent-${manifest.bundledAgentVersion}-${artifact.platform}.tar.gz`,
    );
    expect(artifact.backgroundServiceCapability.installerRequirements).toHaveLength(1);
    expect(
      artifact.backgroundServiceCapability.installerRequirements[0]?.platform,
    ).toBe(artifact.platform.startsWith("darwin-") ? "darwin" : "linux");
    expect(artifact.serviceInstallerBundle.servicePlatforms).toEqual([
      artifact.platform.startsWith("darwin-") ? "darwin" : "linux",
    ]);
    expect(artifact.serviceInstallerBundle.packageArtifacts.map((item) => ({
      packageFormat: item.packageFormat,
      selectedV1Path: item.selectedV1Path,
      publishedArtifactName: item.publishedArtifactName,
      publishedSha256Name: item.publishedSha256Name,
    }))).toEqual(
      [],
    );
  }
});

test("app release gate requires a previous App manifest unless explicitly allowed", () => {
  const defaultResult = spawnSync("bun", [
    "run",
    "--silent",
    "packages/butler-app/scripts/release/release-gate.ts",
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      BUTLER_APP_PREVIOUS_RELEASE_MANIFEST: "",
      BUTLER_APP_ALLOW_MISSING_PREVIOUS_MANIFEST: "",
    },
  });
  expect(defaultResult.status).toBe(1);
  expect(defaultResult.stderr).toContain(
    "previous app release manifest is required for App release gate",
  );

  const firstReleaseResult = spawnSync("bun", [
    "run",
    "--silent",
    "packages/butler-app/scripts/release/release-gate.ts",
    "--allow-missing-previous-manifest",
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      BUTLER_APP_PREVIOUS_RELEASE_MANIFEST: "",
      BUTLER_APP_ALLOW_MISSING_PREVIOUS_MANIFEST: "",
    },
  });
  expect(firstReleaseResult.status).toBe(0);
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
  brokenAgent.agentArtifactLayout = {
    ...brokenAgent.agentArtifactLayout,
    serviceTemplates: [],
  } as any;
  brokenAgent.operatorCommands = ["status"] as any;
  brokenAgent.operatorCommandMap = {
    ...brokenAgent.operatorCommandMap,
    init: ["butler", "init"],
  } as any;
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
      "release artifact layout must include service templates",
      "release operator commands must include init/start/status/stop/doctor",
      "release operator command init must map to butler install",
    ]),
  );

  const brokenApp = structuredClone(createAppReleaseManifest(root));
  brokenApp.product = "butler-service" as any;
  brokenApp.publicProductGroups = ["butler-app", "butler-service"] as any;
  brokenApp.gatewayProfile = "terminal" as any;
  brokenApp.bundledAgentVersion = "0.0.0";
  brokenApp.bundledAgentPayload = undefined as any;
  brokenApp.backgroundServiceCapability = undefined as any;
  brokenApp.serviceInstallerBundle = undefined as any;
  brokenApp.desktopHelper = undefined as any;
  brokenApp.protocolCompatibility = undefined as any;
  brokenApp.components = brokenApp.components.map((component) => ({
    ...component,
    backgroundServiceCapability: undefined as any,
    serviceInstallerBundle: undefined as any,
    desktopHelper: undefined as any,
  }));
  brokenApp.artifacts = brokenApp.artifacts.map((artifact) => ({
    ...artifact,
    product: "butler-service" as any,
    gatewayProfile: "terminal" as any,
    bundledAgentPayload: undefined as any,
    backgroundServiceCapability: undefined as any,
    serviceInstallerBundle: undefined as any,
    desktopHelper: undefined as any,
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
      "app release bundled Agent payload metadata is required",
      "app release background service capability metadata is required",
      "app release service installer bundle metadata is required",
      "app release desktop helper metadata is required",
      "component app background service capability metadata is required",
      "component app service installer bundle metadata is required",
      "component app desktop helper metadata is required",
      "artifact app product must be butler-app",
      "artifact app gateway profile must be electron",
      "artifact app bundled agent version mismatch",
      "artifact app bundled Agent payload metadata is required",
      "artifact app background service capability metadata is required",
      "artifact app service installer bundle metadata is required",
      "artifact app desktop helper metadata is required",
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
  expect(createAppReleaseManifest(root).artifacts.every(
    (artifact) => artifact.serviceInstallerBundle.packageArtifacts.length === 0,
  )).toBe(true);
});

test("agent release packager creates an installable artifact with app web client", () => {
  const outDir = mkdtempSync(join(tmpdir(), "Butler 에이전트 release test "));
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
    expect(result.artifactName).toBe(`butler-agent-${currentVersion}-all.tar.gz`);
    expect(result.releaseManifestPath.endsWith("agent-release-manifest.json")).toBe(true);
    expect(result.updateManifestPath.endsWith("agent-update-manifest.json")).toBe(true);

    const entries: string[] = [];
    const linkEntries: string[] = [];
    listTarArchive({
      file: result.artifactPath,
      sync: true,
      onentry: (entry) => {
        entries.push(entry.path);
        if (entry.type === "SymbolicLink" || entry.type === "Link") {
          linkEntries.push(entry.path);
        }
        entry.resume();
      },
    });
    expect(linkEntries).toEqual([]);
    const currentCliLauncher = serviceCliLauncherRelativePath(
      currentCliPlatform,
    );
    expect(entries).toContain("./install.sh");
    expect(entries).toContain("./package.json");
    expect(entries).toContain("./bin/butler.js");
    expect(entries).toContain("./deploy/agent/package-agent.ts");
    expect(entries).toContain("./deploy/agent/release-gate.ts");
    expect(entries).toContain("./deploy/agent/smoke.ts");
    expect(entries).toContain("./deploy/agent/templates/launchd.plist.template");
    expect(entries).toContain("./deploy/agent/templates/systemd.service.template");
    expect(entries).toContain(`./${currentCliLauncher}`);
    expect(entries).toContain("./packages/butler-agent/scripts/service-control.sh");
    expect(entries).toContain(
      "./packages/butler-agent/src/foundation/atomic-root-exchange.ts",
    );
    expect(entries).toContain("./packages/project-ledger/bin/project-ledger");
    expect(entries).toContain(`./${SERVICE_APP_WEB_CLIENT_DIST}/index.html`);
    expect(entries.some((entry) => entry.startsWith(`./${SERVICE_APP_WEB_CLIENT_DIST}/assets/`))).toBe(true);
    expect(entries.some((entry) => entry.includes("packages/butler-app/"))).toBe(false);
    expect(entries.some((entry) =>
      entry.includes("/node_modules/@huggingface/transformers/package.json"),
    )).toBe(true);
    expect(entries.some((entry) =>
      entry.includes("/node_modules/onnxruntime-common/package.json"),
    )).toBe(true);
    expect(entries.some((entry) =>
      entry.includes("/node_modules/onnxruntime-node/package.json"),
    )).toBe(true);
    expect(entries).toContain("./node_modules/@asamuzakjp/css-color/package.json");
    expect(entries).toContain(
      "./node_modules/@csstools/css-parser-algorithms/package.json",
    );
    expect(entries).toContain("./node_modules/micromark-extension-gfm/package.json");
    expect(entries).toContain(
      "./node_modules/micromark-extension-gfm-autolink-literal/package.json",
    );

    const extractDir = mkdtempSync(join(tmpdir(), "butler-agent-release-extract-"));
    try {
      extractTarArchive({
        cwd: extractDir,
        file: result.artifactPath,
        sync: true,
      });
      const packagedRootPackage = JSON.parse(
        readText(join(extractDir, "package.json")),
      );
      expect(packagedRootPackage.workspaces).toEqual([
        "packages/butler-progress-projection",
        "packages/project-ledger",
        "packages/butler-agent/src/interfaces/mcp-server",
        "packages/butler-agent/src/integrations/telegram",
      ]);
      expect(JSON.stringify(packagedRootPackage)).not.toContain("packages/butler-app");
      expect(entries.some((entry) =>
        entry.includes("/node_modules/onnxruntime-common/dist/"),
      )).toBe(true);
      expect(
        readText(join(extractDir, SERVICE_APP_WEB_CLIENT_DIST, "index.html")),
      ).toContain("<title>Butler</title>");
      expect(
        readText(join(extractDir, "deploy/agent/templates/systemd.service.template")),
      ).toContain("butler.js service run");
      expect(
        readText(join(extractDir, "deploy/agent/templates/launchd.plist.template")),
      ).toContain("<string>run</string>");
      const dependencyResolution = spawnSync(process.execPath, ["-e", `
        const { pathToFileURL } = require("url");
        const { join } = require("path");
        await import(pathToFileURL(join(process.cwd(), "node_modules/@asamuzakjp/css-color/dist/esm/index.js")).href);
        await import(pathToFileURL(join(process.cwd(), "node_modules/micromark-extension-gfm/index.js")).href);
      `], {
        cwd: extractDir,
        encoding: "utf8",
      });
      expect(dependencyResolution.status).toBe(0);
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
    expect(updateManifest.agent_artifact_layout).toMatchObject({
      executable: "bin/butler.js",
      runtime_resolver: "packages/butler-agent/scripts/start-butler.sh",
      service_templates: [
        "deploy/agent/templates/launchd.plist.template",
        "deploy/agent/templates/systemd.service.template",
      ],
    });
    expect(updateManifest.operator_commands).toEqual([
      "init",
      "start",
      "status",
      "stop",
      "doctor",
    ]);
    expect(updateManifest.operator_command_map.init).toEqual(["butler", "install"]);
    expect(updateManifest.operator_command_map.start).toEqual(["butler", "start"]);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}, 180_000);
test("agent release packager can write public GitHub artifact URLs", () => {
  const outDir = mkdtempSync(join(tmpdir(), "butler-agent-release-url-test-"));
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
}, 90_000);

test("app bundled Agent foreground payload excludes a Linux service launcher", () => {
  const outDir = mkdtempSync(join(tmpdir(), "butler-app-launcher-app-version-test-"));
  const previousLinuxRuntime = process.env.BUTLER_APP_MANAGED_BUN_LINUX_X64;
  try {
    process.env.BUTLER_APP_MANAGED_BUN_LINUX_X64 = writeFakeLinuxX64Runtime(outDir);
    const agentArtifactPath = join(outDir, "butler-agent-9.9.9-all.tar.gz");
    const agentReleaseManifestPath = join(outDir, "agent-release-manifest.json");
    const agentUpdateManifestPath = join(outDir, "agent-update-manifest.json");
    writeFileSync(agentArtifactPath, "fake agent archive");
    writeFileSync(agentReleaseManifestPath, "{}\n");
    writeFileSync(agentUpdateManifestPath, "{}\n");

    const resource = prepareBundledAgentResourceFromPackage(
      root,
      outDir,
      "linux-x64",
      {
        artifactPath: agentArtifactPath,
        releaseManifestPath: agentReleaseManifestPath,
        updateManifestPath: agentUpdateManifestPath,
        artifactName: "butler-agent-9.9.9-all.tar.gz",
        sha256: "a".repeat(64),
        version: "9.9.9",
      },
      "2.3.4",
    );

    expect(existsSync(join(
      resource.resourceDir,
      "service-installer",
      "linux",
      "launcher",
      "butler-app-managed-agent-service",
    ))).toBe(false);
  } finally {
    if (previousLinuxRuntime === undefined) delete process.env.BUTLER_APP_MANAGED_BUN_LINUX_X64;
    else process.env.BUTLER_APP_MANAGED_BUN_LINUX_X64 = previousLinuxRuntime;
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("app release packager embeds self-contained bundled Agent resources", () => {
  const outDir = mkdtempSync(join(tmpdir(), "butler-app-release-test-"));
  const previousLinuxRuntime = process.env.BUTLER_APP_MANAGED_BUN_LINUX_X64;
  const previousDpkgDeb = process.env.BUTLER_APP_DPKG_DEB;
  try {
    process.env.BUTLER_APP_MANAGED_BUN_LINUX_X64 = writeFakeLinuxX64Runtime(outDir);
    process.env.BUTLER_APP_DPKG_DEB = writeFakeDpkgDeb(outDir);
    const result = createAppReleasePackage({
      root,
      outDir,
      platforms: ["linux-x64"],
    });
    const artifact = result.artifacts[0];
    expect(artifact?.artifactName).toBe(`butler-app-${currentVersion}-linux-x64.deb`);
    expect(existsSync(artifact.artifactPath)).toBe(true);

    const listing = spawnSync("tar", ["-tzf", artifact.artifactPath], {
      encoding: "utf8",
    });
    expect(listing.status).toBe(0);
    const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
    const resourceRoot = "./opt/butler/Butler-linux-x64/resources/bundled-agent";
    const agentArtifact = `butler-agent-${currentVersion}-linux-x64.tar.gz`;
    expect(tarVerboseListing(artifact.artifactPath)).toContain("drwxr-xr-x");
    expect(entries).toContain("./opt/butler/Butler-linux-x64/Butler");
    expect(entries).toContain("./usr/bin/butler-app");
    expect(entries).not.toContain("./usr/lib/systemd/user/butler.service");
    expect(entries).not.toContain("./usr/lib/butler/butler-app-managed-agent-service");
    expect(entries).toContain("./usr/share/applications/butler.desktop");
    expect(entries).toContain("./usr/share/icons/hicolor/512x512/apps/butler.png");
    expect(entries).toContain(`${resourceRoot}/${agentArtifact}`);
    expect(entries).toContain(`${resourceRoot}/agent-release-manifest.json`);
    expect(entries).toContain(`${resourceRoot}/agent-update-manifest.json`);
    expect(entries).toContain(`${resourceRoot}/dependency-closure.json`);
    expect(entries).toContain(`${resourceRoot}/background-service-capability.json`);
    expect(entries).toContain(`${resourceRoot}/background-service-registration.json`);
    expect(entries).toContain(`${resourceRoot}/service-installer/installer-manifest.json`);
    expect(entries).not.toContain(`${resourceRoot}/service-installer/linux/systemd/render-contract.json`);
    expect(entries).toContain(`${resourceRoot}/runtime/bun-version`);
    expect(entries).toContain(`${resourceRoot}/runtime/bin/bun`);
    expect(extractTarEntryText(artifact.artifactPath, "./usr/bin/butler-app")).toContain(
      'exec "/opt/butler/Butler-linux-x64/Butler" "${chromium_flags[@]}" "$@"',
    );
    expect(extractTarEntryText(artifact.artifactPath, "./usr/bin/butler-app")).toContain(
      "BUTLER_APP_ENABLE_GPU",
    );
    expect(extractTarEntryText(artifact.artifactPath, "./DEBIAN/postinst")).toContain(
      'find "/opt/butler/Butler-linux-x64" -type d -exec chmod 755 {} +',
    );
    expect(extractTarEntryText(artifact.artifactPath, "./DEBIAN/postinst")).toContain(
      'if [ -f "/opt/butler/Butler-linux-x64/chrome-sandbox" ] && [ ! -L "/opt/butler/Butler-linux-x64/chrome-sandbox" ]; then',
    );
    const bundledRuntime = extractTarEntryBuffer(
      artifact.artifactPath,
      `${resourceRoot}/runtime/bin/bun`,
    );
    expect(isElfX64(bundledRuntime)).toBe(true);

    const releaseManifest = JSON.parse(readText(result.releaseManifestPath));
    const updateManifest = JSON.parse(readText(result.updateManifestPath));
    const topLevelAgentArtifact = `butler-agent-${currentVersion}-all.tar.gz`;
    expect(releaseManifest).toMatchObject({
      version: currentVersion,
      gatewayProfile: "electron",
      bundledAgentVersion: currentVersion,
      bundledAgentPayload: {
        version: currentVersion,
        artifactName: topLevelAgentArtifact,
        resourcePath: `bundled-agent/${topLevelAgentArtifact}`,
        managedRuntimePayloadPath: "bundled-agent/runtime",
        dependencyClosureManifestPath: "bundled-agent/dependency-closure.json",
      },
      backgroundServiceCapability: {
        serviceCapable: true,
        appGatewayOwner: "background-agent-service",
      },
    });
    expect(validateAppReleaseManifest(root, releaseManifest, {
      expectedPlatforms: ["linux-x64"],
    })).toEqual([]);
    const releaseArtifact = releaseManifest.artifacts.find(
      (item: any) => item.platform === "linux-x64",
    );
    expect(releaseArtifact?.bundledAgentPayload).toMatchObject({
      version: currentVersion,
      artifactName: agentArtifact,
      resourcePath: `bundled-agent/${agentArtifact}`,
    });
    const bundledAgentDigest = releaseArtifact?.bundledAgentPayload?.integrity?.digest;
    expect(typeof bundledAgentDigest).toBe("string");
    expect(updateManifest).toMatchObject({
      schema: "butler.update-manifest.v1",
      product: "butler-app",
      app_version: currentVersion,
      bundled_agent_version: currentVersion,
      background_service_capability: {
        serviceCapable: true,
        appGatewayOwner: "background-agent-service",
      },
      service_installer_bundle: {
        servicePlatforms: ["linux"],
        packageArtifacts: [],
      },
      gateway_profile: "electron",
      protocol_compatibility: {
        protocol: "butler.app.v1",
        minimumAppProtocol: "butler.app.v1",
        maximumAppProtocol: "butler.app.v1",
      },
      updater_owner: "butler-app",
    });
    expect(
      updateManifest.artifacts.find((artifact: any) => artifact.platform === "linux-x64"),
    ).toMatchObject({
      product: "butler-app",
      component: "app",
      app_version: currentVersion,
      version: currentVersion,
      gateway_profile: "electron",
      bundled_agent_version: currentVersion,
      background_service_capability: {
        serviceCapable: true,
        appGatewayOwner: "background-agent-service",
      },
      service_installer_bundle: {
        servicePlatforms: ["linux"],
        packageArtifacts: [],
      },
      protocol_compatibility: {
        protocol: "butler.app.v1",
        minimumAppProtocol: "butler.app.v1",
        maximumAppProtocol: "butler.app.v1",
      },
      updater_owner: "butler-app",
    });

    const nestedReleaseManifest = extractTarEntryJson(
      artifact.artifactPath,
      `${resourceRoot}/agent-release-manifest.json`,
    );
    const nestedUpdateManifest = extractTarEntryJson(
      artifact.artifactPath,
      `${resourceRoot}/agent-update-manifest.json`,
    );
    const backgroundServiceCapability = extractTarEntryJson(
      artifact.artifactPath,
      `${resourceRoot}/background-service-capability.json`,
    );
    const backgroundServiceRegistration = extractTarEntryJson(
      artifact.artifactPath,
      `${resourceRoot}/background-service-registration.json`,
    );
    const serviceInstallerManifest = extractTarEntryJson(
      artifact.artifactPath,
      `${resourceRoot}/service-installer/installer-manifest.json`,
    );
    expect(backgroundServiceCapability).toMatchObject({
      schema: "butler.app-background-service-capability.v1",
      serviceCapable: true,
      gatewayProfile: "electron",
      appGatewayOwner: "background-agent-service",
      installerRequirements: [
        {
          platform: "linux",
          selectedV1Path: "linux-app-foreground",
          installerRequired: "no",
          packageFormats: ["deb", "pacman"],
          registersUserService: false,
        },
      ],
      rawTextIncluded: false,
    });
    expect(serviceInstallerManifest).toMatchObject({
      schema: "butler.app-service-installer-bundle.v1",
      product: "butler-app",
      releasePlatform: "linux-x64",
      servicePlatform: "linux",
      gatewayProfile: "electron",
      renderer: "butler-app-native-service-bridge",
      hostToolsRequiredForFirstLaunch: [],
      rawTemplateIncluded: false,
      rawTextIncluded: false,
      packageArtifacts: [],
    });
    expect(backgroundServiceRegistration).toMatchObject({
      schema: "butler.app-background-service-registration.v1",
      product: "butler-app",
      releasePlatform: "linux-x64",
      servicePlatform: "linux",
      gatewayProfile: "electron",
      installerRequired: "no",
      packageFormats: ["deb", "pacman"],
      packageInstallerTargets: [],
      registersUserService: false,
      runtimePointerPath: "$BUTLER_DATA/app/runtime/agent/current.json",
      localAuthPath: "$BUTLER_DATA/app/runtime/auth/local-agent-auth.json",
      serviceDefinition: null,
      desktopHelper: {
        schema: "butler.app-desktop-helper.v1",
        helperMode: "electron-main-tray",
        defaultEnabledPlatforms: [],
        survivesMainUiQuitPlatforms: [],
        stopsAgentOnHelperQuit: false,
        launchArgument: "--butler-menu-bar-helper",
        quitMainUiArgument: "--butler-quit-main-ui",
        quitHelperArgument: "--butler-quit-menu-bar-helper",
        platforms: ["linux"],
        rawTextIncluded: false,
      },
      requiredEnvironment: [
        "BUTLER_HOME",
        "BUTLER_DATA",
        "BUTLER_BUN",
        "BUTLER_APP_MANAGED_RUNTIME_POINTER",
        "BUTLER_APP_MANAGED_RUNTIME_HOME",
        "BUTLER_APP_SERVER_HOST",
        "BUTLER_APP_SERVER_PORT",
        "BUTLER_APP_GATEWAY_PID_FILE",
        "BUTLER_APP_LOCAL_AUTH_REQUIRED",
        "BUTLER_APP_LOCAL_AUTH_FILE",
      ],
      rawTextIncluded: false,
    });
    expect(nestedReleaseManifest.artifacts[0]).toMatchObject({
      downloadUrl: `bundled-agent/${agentArtifact}`,
      sha256: bundledAgentDigest,
    });
    expect(nestedUpdateManifest.artifacts[0]).toMatchObject({
      artifact_url: `bundled-agent/${agentArtifact}`,
      sha256: bundledAgentDigest,
    });
    expect(JSON.stringify(nestedReleaseManifest)).not.toContain("file://");
    expect(JSON.stringify(nestedUpdateManifest)).not.toContain("file://");

    const nestedAgentBytes = spawnSync("tar", [
      "-xOf",
      artifact.artifactPath,
      `${resourceRoot}/${agentArtifact}`,
    ], {
      maxBuffer: 768 * 1024 * 1024,
    });
    expect(nestedAgentBytes.status).toBe(0);
    const nestedListing = spawnSync("tar", ["-tzf", "-"], {
      input: nestedAgentBytes.stdout,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(nestedListing.status).toBe(0);
    const nestedEntries = nestedListing.stdout.split(/\r?\n/).filter(Boolean);
    for (const platform of SERVICE_CLI_LAUNCHER_PLATFORMS) {
      const launcherPath = `./${serviceCliLauncherRelativePath(platform)}`;
      if (platform === "linux-x64") {
        expect(nestedEntries).toContain(launcherPath);
      } else {
        expect(nestedEntries).not.toContain(launcherPath);
      }
    }
  } finally {
    if (previousLinuxRuntime === undefined) delete process.env.BUTLER_APP_MANAGED_BUN_LINUX_X64;
    else process.env.BUTLER_APP_MANAGED_BUN_LINUX_X64 = previousLinuxRuntime;
    if (previousDpkgDeb === undefined) delete process.env.BUTLER_APP_DPKG_DEB;
    else process.env.BUTLER_APP_DPKG_DEB = previousDpkgDeb;
    rmSync(outDir, { recursive: true, force: true });
  }
}, 90_000);

test("app release packager creates Linux ARM64 deb staging", () => {
  const outDir = mkdtempSync(join(tmpdir(), "butler-app-linux-arm64-release-test-"));
  const previousLinuxRuntime = process.env.BUTLER_APP_MANAGED_BUN_LINUX_ARM64;
  const previousDpkgDeb = process.env.BUTLER_APP_DPKG_DEB;
  try {
    process.env.BUTLER_APP_MANAGED_BUN_LINUX_ARM64 = writeFakeLinuxArm64Runtime(outDir);
    process.env.BUTLER_APP_DPKG_DEB = writeFakeDpkgDeb(outDir);
    const result = createAppReleasePackage({
      root,
      outDir,
      platforms: ["linux-arm64"],
    });
    const artifact = result.artifacts[0];
    expect(artifact?.artifactName).toBe(`butler-app-${currentVersion}-linux-arm64.deb`);
    expect(existsSync(artifact.artifactPath)).toBe(true);

    const listing = spawnSync("tar", ["-tzf", artifact.artifactPath], {
      encoding: "utf8",
    });
    expect(listing.status).toBe(0);
    expect(tarVerboseListing(artifact.artifactPath)).toContain("drwxr-xr-x");
    expect(listing.stdout).toContain("./opt/butler/Butler-linux-arm64/Butler");
    expect(listing.stdout).toContain("./usr/bin/butler-app");
    expect(listing.stdout).not.toContain("./usr/lib/systemd/user/butler.service");
    expect(listing.stdout).not.toContain("./usr/lib/butler/butler-app-managed-agent-service");
    expect(listing.stdout).toContain(
      "./opt/butler/Butler-linux-arm64/resources/bundled-agent/runtime/bin/bun",
    );
    expect(extractTarEntryText(artifact.artifactPath, "./DEBIAN/control")).toContain(
      "Architecture: arm64",
    );
    expect(extractTarEntryText(artifact.artifactPath, "./usr/bin/butler-app")).toContain(
      'exec "/opt/butler/Butler-linux-arm64/Butler" "${chromium_flags[@]}" "$@"',
    );
    expect(extractTarEntryText(artifact.artifactPath, "./usr/bin/butler-app")).toContain(
      "--disable-gpu",
    );
    expect(extractTarEntryText(artifact.artifactPath, "./DEBIAN/postinst")).toContain(
      'find "/opt/butler/Butler-linux-arm64" -type d -exec chmod 755 {} +',
    );
    expect(extractTarEntryText(artifact.artifactPath, "./DEBIAN/postinst")).toContain(
      'if [ -f "/opt/butler/Butler-linux-arm64/chrome-sandbox" ] && [ ! -L "/opt/butler/Butler-linux-arm64/chrome-sandbox" ]; then',
    );
  } finally {
    if (previousLinuxRuntime === undefined) delete process.env.BUTLER_APP_MANAGED_BUN_LINUX_ARM64;
    else process.env.BUTLER_APP_MANAGED_BUN_LINUX_ARM64 = previousLinuxRuntime;
    if (previousDpkgDeb === undefined) delete process.env.BUTLER_APP_DPKG_DEB;
    else process.env.BUTLER_APP_DPKG_DEB = previousDpkgDeb;
    rmSync(outDir, { recursive: true, force: true });
  }
}, 90_000);

test("app release packager can create Linux x64 pacman package staging", () => {
  const outDir = mkdtempSync(join(tmpdir(), "butler-app-linux-pacman-release-test-"));
  const previousLinuxRuntime = process.env.BUTLER_APP_MANAGED_BUN_LINUX_X64;
  const previousBun = process.env.BUTLER_BUN;
  const previousPackager = process.env.BUTLER_APP_PACKAGER;
  const previousMakepkg = process.env.BUTLER_APP_MAKEPKG;
  const rendererDist = join(root, "packages", "butler-app", "client", "ui", "dist");
  const createdRendererDist = !existsSync(join(rendererDist, "index.html"));
  try {
    if (createdRendererDist) {
      mkdirSync(rendererDist, { recursive: true });
      writeFileSync(join(rendererDist, "index.html"), "<title>Butler</title>\n");
    }
    process.env.BUTLER_APP_MANAGED_BUN_LINUX_X64 = writeFakeLinuxX64Runtime(outDir);
    process.env.BUTLER_BUN = writeFakeAgentPackager(outDir);
    process.env.BUTLER_APP_PACKAGER = writeFakeElectronPackager(outDir);
    process.env.BUTLER_APP_MAKEPKG = writeFakeMakepkg(outDir);
    const result = createAppReleasePackage({
      root,
      outDir,
      platforms: ["linux-x64"],
      linuxPackageFormat: "pacman",
    });
    const artifact = result.artifacts[0];
    expect(artifact?.artifactName).toBe(`butler-app-${currentVersion}-archlinux-x64.pkg.tar.zst`);
    expect(existsSync(artifact.artifactPath)).toBe(true);

    const listing = spawnSync("tar", ["-tzf", artifact.artifactPath], {
      encoding: "utf8",
    });
    expect(listing.status).toBe(0);
    expect(listing.stdout).toContain("./opt/butler/Butler-linux-x64/Butler");
    expect(listing.stdout).toContain("./usr/bin/butler-app");
    expect(listing.stdout).not.toContain("./usr/lib/systemd/user/butler.service");
    expect(listing.stdout).not.toContain("./usr/lib/butler/butler-app-managed-agent-service");
    expect(listing.stdout).toContain("./usr/share/applications/butler.desktop");
    expect(listing.stdout).toContain("./usr/share/icons/hicolor/512x512/apps/butler.png");
    expect(listing.stdout).toContain("./usr/share/licenses/butler-app/LICENSE");
    expect(
      extractTarEntryText(artifact.artifactPath, "./usr/bin/butler-app"),
    ).toContain('exec "/opt/butler/Butler-linux-x64/Butler" "${chromium_flags[@]}" "$@"');

    const releaseManifest = JSON.parse(readText(result.releaseManifestPath));
    const updateManifest = JSON.parse(readText(result.updateManifestPath));
    expect(releaseManifest.artifacts.find((item: any) => item.platform === "linux-x64")).toMatchObject({
      artifactName: `butler-app-${currentVersion}-archlinux-x64.pkg.tar.zst`,
      sha256: artifact.sha256,
    });
    expect(updateManifest.artifacts.find((item: any) => item.platform === "linux-x64")).toMatchObject({
      artifact_url: `file://${artifact.artifactPath}`,
      sha256: artifact.sha256,
      service_installer_bundle: {
        packageArtifacts: [],
      },
    });
  } finally {
    restoreEnv("BUTLER_APP_MANAGED_BUN_LINUX_X64", previousLinuxRuntime);
    restoreEnv("BUTLER_BUN", previousBun);
    restoreEnv("BUTLER_APP_PACKAGER", previousPackager);
    restoreEnv("BUTLER_APP_MAKEPKG", previousMakepkg);
    if (createdRendererDist) rmSync(rendererDist, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
}, 90_000);

test("app package smoke uses real bundled Agent release resources", () => {
  const workDir = mkdtempSync(join(tmpdir(), "butler-app-smoke-agent-resource-"));
  try {
    const bundledAgent = prepareBundledAgentResource(root, workDir);
    expect(bundledAgent.artifactName).toBe(`butler-agent-${currentVersion}-${bundledAgent.platform}.tar.gz`);
    expect(bundledAgent.version).toBe(currentVersion);
    expect(existsSync(join(bundledAgent.resourceDir, bundledAgent.artifactName))).toBe(true);
    expect(existsSync(join(bundledAgent.resourceDir, "agent-release-manifest.json"))).toBe(true);
    expect(existsSync(join(bundledAgent.resourceDir, "agent-update-manifest.json"))).toBe(true);
    expect(existsSync(join(bundledAgent.resourceDir, "dependency-closure.json"))).toBe(true);
    expect(existsSync(join(bundledAgent.resourceDir, "background-service-capability.json"))).toBe(true);
    expect(existsSync(join(bundledAgent.resourceDir, "background-service-registration.json"))).toBe(true);
    expect(existsSync(join(
      bundledAgent.resourceDir,
      "service-installer",
      "installer-manifest.json",
    ))).toBe(true);
    expect(existsSync(join(
      bundledAgent.resourceDir,
      "service-installer",
      bundledAgent.platform.startsWith("darwin-") ? "darwin" : "linux",
    ))).toBe(false);

    const listing = spawnSync("tar", [
      "-tzf",
      join(bundledAgent.resourceDir, bundledAgent.artifactName),
    ], { encoding: "utf8" });
    expect(listing.status).toBe(0);
    expect(listing.stdout).toContain("bin/butler.js");
    expect(listing.stdout).toContain(`./${SERVICE_APP_WEB_CLIENT_DIST}/index.html`);
    expect(listing.stdout).toContain(`./${SERVICE_APP_WEB_CLIENT_DIST}/assets/`);
    expect(listing.stdout).toContain(
      "packages/butler-agent/resources/runtime/bun-version",
    );
    expect(existsSync(join(bundledAgent.resourceDir, "runtime", "bin", "bun"))).toBe(true);

    const releaseManifest = JSON.parse(
      readText(join(bundledAgent.resourceDir, "agent-release-manifest.json")),
    );
    expect(releaseManifest.artifacts[0]).toMatchObject({
      artifactName: bundledAgent.artifactName,
      sha256: bundledAgent.sha256,
    });

    const dependencyClosure = JSON.parse(
      readText(join(bundledAgent.resourceDir, "dependency-closure.json")),
    );
    expect(dependencyClosure).toMatchObject({
      product: "butler-app",
      bundledAgentVersion: currentVersion,
      gatewayProfile: "electron",
      payload: {
        product: "butler-agent",
        artifactName: bundledAgent.artifactName,
        sha256: bundledAgent.sha256,
        integrity: {
          digestAlgorithm: "sha256",
          digest: bundledAgent.sha256,
          signature: null,
        },
      },
      hostToolsRequiredForFirstLaunch: [],
    });
    expect(dependencyClosure.appOwnedDependencies.map((item: any) => item.id)).toEqual([
      "electron-shell",
      "renderer-assets",
      "bootstrap-setup-ui",
      "bundled-agent-payload",
      "managed-runtime-payload",
      "runtime-package-dependencies",
      "local-setup-bridge",
      "release-manifests",
      "background-service-registration-metadata",
      "app-managed-runtime-home",
      "bundled-payload-repair-source",
    ]);
    expect(
      dependencyClosure.appOwnedDependencies.find(
        (item: any) => item.id === "background-service-registration-metadata",
      ),
    ).toMatchObject({
      source: "app-bundle",
      paths: [
        "bundled-agent/background-service-capability.json",
        "bundled-agent/background-service-registration.json",
        "bundled-agent/service-installer",
      ],
      repairSource: "bundled-payload-repair-source",
      integrity: {
        digestAlgorithm: "sha256",
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        signature: null,
      },
    });
    expect(
      dependencyClosure.appOwnedDependencies.find(
        (item: any) => item.id === "renderer-assets",
      ),
    ).toMatchObject({
      source: "signed-butler-payload",
      paths: [
        `bundled-agent/${bundledAgent.artifactName}!${SERVICE_APP_WEB_CLIENT_DIST}`,
        `bundled-agent/${bundledAgent.artifactName}!${SERVICE_APP_WEB_CLIENT_DIST}/index.html`,
      ],
      integrity: {
        digestAlgorithm: "sha256",
        digest: bundledAgent.sha256,
      },
      repairSource: "bundled-payload-repair-source",
    });
    expect(
      dependencyClosure.appOwnedDependencies.find(
        (item: any) => item.id === "bootstrap-setup-ui",
      ),
    ).toMatchObject({
      source: "signed-butler-payload",
      paths: [
        `bundled-agent/${bundledAgent.artifactName}!${SERVICE_APP_WEB_CLIENT_DIST}`,
      ],
      integrity: {
        digestAlgorithm: "sha256",
        digest: bundledAgent.sha256,
      },
      repairSource: "bundled-payload-repair-source",
    });
    for (const dependency of dependencyClosure.appOwnedDependencies.filter(
      (item: any) => item.source === "signed-butler-payload",
    )) {
      expect(dependency.integrity?.digestAlgorithm).toBe("sha256");
      expect(typeof dependency.integrity?.digest).toBe("string");
      expect(dependency.integrity.digest).toHaveLength(64);
    }
    expect(
      dependencyClosure.appOwnedDependencies.find(
        (item: any) => item.id === "bundled-agent-payload",
      ).integrity.digest,
    ).toBe(bundledAgent.sha256);
    expect(
      dependencyClosure.appOwnedDependencies.find(
        (item: any) => item.id === "managed-runtime-payload",
      ).integrity.digest,
    ).not.toBe(bundledAgent.sha256);
    expect(
      dependencyClosure.appOwnedDependencies.find(
        (item: any) => item.id === "managed-runtime-payload",
      ).paths,
    ).toEqual([
      "bundled-agent/runtime",
      "bundled-agent/runtime/bun-version",
      "bundled-agent/runtime/bin/bun",
    ]);
    expect(
      dependencyClosure.appOwnedDependencies.find(
        (item: any) => item.id === "release-manifests",
      ).paths,
    ).toEqual([
      "bundled-agent/agent-release-manifest.json",
      "bundled-agent/agent-update-manifest.json",
    ]);
    expect(dependencyClosure.repairSources).toEqual([
      {
        id: "bundled-payload-repair-source",
        source: "app-bundle",
        paths: [
          `bundled-agent/${bundledAgent.artifactName}`,
          "bundled-agent/agent-release-manifest.json",
          "bundled-agent/agent-update-manifest.json",
          "bundled-agent/runtime",
          "bundled-agent/background-service-capability.json",
          "bundled-agent/background-service-registration.json",
          "bundled-agent/service-installer",
        ],
        verification: "sha256",
        integrity: {
          digestAlgorithm: "sha256",
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
          signature: null,
        },
      },
    ]);
    expect(dependencyClosure.runtimePackageDependencies).toEqual([
      {
        id: "managed-bun-runtime",
        path: "bundled-agent/runtime",
        requiredForFirstLaunch: true,
        repairSource: "bundled-payload-repair-source",
      },
    ]);
    expect(validateAppDependencyClosureManifest(dependencyClosure)).toEqual([]);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}, 60_000);

test("app package smoke excludes macOS service registration payload", () => {
  const workDir = mkdtempSync(join(tmpdir(), "butler-app-smoke-darwin-agent-resource-"));
  const previousDarwinRuntime = process.env.BUTLER_APP_MANAGED_BUN_DARWIN_ARM64;
  try {
    process.env.BUTLER_APP_MANAGED_BUN_DARWIN_ARM64 = writeFakeDarwinArm64Runtime(workDir);
    const bundledAgent = prepareBundledAgentResource(root, workDir, "darwin-arm64");
    expect(bundledAgent.platform).toBe("darwin-arm64");
    expect(existsSync(join(
      bundledAgent.resourceDir,
      "service-installer",
      "darwin",
    ))).toBe(false);
    expect(
      JSON.parse(readText(join(
        bundledAgent.resourceDir,
        "service-installer",
        "installer-manifest.json",
      ))),
    ).toMatchObject({
      schema: "butler.app-service-installer-bundle.v1",
      releasePlatform: "darwin-arm64",
      servicePlatform: "darwin",
      packageArtifacts: [],
    });
  } finally {
    if (previousDarwinRuntime === undefined) {
      delete process.env.BUTLER_APP_MANAGED_BUN_DARWIN_ARM64;
    } else {
      process.env.BUTLER_APP_MANAGED_BUN_DARWIN_ARM64 = previousDarwinRuntime;
    }
    rmSync(workDir, { recursive: true, force: true });
  }
}, 60_000);

test("Linux App payload declares foreground ownership without service installers", () => {
  const workDir = mkdtempSync(join(tmpdir(), "butler-linux-foreground-payload-"));
  const previousLinuxRuntime = process.env.BUTLER_APP_MANAGED_BUN_LINUX_X64;
  try {
    process.env.BUTLER_APP_MANAGED_BUN_LINUX_X64 = writeFakeLinuxX64Runtime(workDir);
    const bundledAgent = prepareBundledAgentResource(root, workDir, "linux-x64");
    const registration = JSON.parse(readText(join(
      bundledAgent.resourceDir,
      "background-service-registration.json",
    )));
    const installer = JSON.parse(readText(join(
      bundledAgent.resourceDir,
      "service-installer",
      "installer-manifest.json",
    )));
    expect(registration).toMatchObject({
      installerRequired: "no",
      registersUserService: false,
      serviceDefinition: null,
    });
    expect(installer).toMatchObject({
      servicePlatform: "linux",
      packageArtifacts: [],
    });
    expect(existsSync(join(
      bundledAgent.resourceDir,
      "service-installer",
      "linux",
    ))).toBe(false);
  } finally {
    restoreEnv("BUTLER_APP_MANAGED_BUN_LINUX_X64", previousLinuxRuntime);
    rmSync(workDir, { recursive: true, force: true });
  }
}, 60_000);

test("app dependency closure manifest validation rejects missing owned dependencies", () => {
  const workDir = mkdtempSync(join(tmpdir(), "butler-app-dependency-closure-validation-"));
  try {
    const bundledAgent = prepareBundledAgentResource(root, workDir);
    const dependencyClosure = JSON.parse(
      readText(join(bundledAgent.resourceDir, "dependency-closure.json")),
    );
    dependencyClosure.hostToolsRequiredForFirstLaunch = ["curl"];
    dependencyClosure.appOwnedDependencies = dependencyClosure.appOwnedDependencies.filter(
      (item: any) => item.id !== "bootstrap-setup-ui",
    );
    dependencyClosure.payload.integrity.digest = null;
    dependencyClosure.appOwnedDependencies.find(
      (item: any) => item.id === "managed-runtime-payload",
    ).integrity.digest = null;
    dependencyClosure.appOwnedDependencies.find(
      (item: any) => item.id === "managed-runtime-payload",
    ).paths = [
      "bundled-agent/runtime",
      "bundled-agent/runtime/bun-version",
    ];
    dependencyClosure.repairSources = [];

    expect(validateAppDependencyClosureManifest(dependencyClosure)).toEqual(
      expect.arrayContaining([
        "dependency closure must not require host first-launch tools",
        "dependency closure missing app-owned dependency: bootstrap-setup-ui",
        "dependency closure bundled Agent payload digest is required",
        "dependency closure managed-runtime-payload digest is required",
        "dependency closure managed runtime must include bundled Bun executable",
        "dependency closure repair source is required",
      ]),
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}, 60_000);

test("Butler CLI help documents install home and data overrides", () => {
  const result = spawnSync("node", [join(root, "bin", "butler.js"), "--help"], {
    cwd: root,
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("butler install [--profile agent-standalone] [--home PATH] [--data PATH]");
  expect(result.stdout).toContain("BUTLER_HOME: ~/butler");
  expect(result.stdout).toContain("BUTLER_DATA: ~/.butler");
});

test("package-owned release gate scripts pass in the repo checkout", () => {
  const defaultEnv = { ...process.env };
  delete defaultEnv.BUTLER_VALIDATE_VERBOSE;
  defaultEnv.BUTLER_HOME = join(root, ".stale-butler-home");
  const workDir = mkdtempSync(join(tmpdir(), "butler-release-gate-baseline-"));
  const previousAppManifestPath = join(workDir, "app-release-manifest.json");
  writeFileSync(
    previousAppManifestPath,
    JSON.stringify({
      version: "0.0.0",
      bundledAgentVersion: currentVersion,
    }),
  );
  const appEnv = {
    ...defaultEnv,
    BUTLER_APP_PREVIOUS_RELEASE_MANIFEST: previousAppManifestPath,
  };
  const agent = spawnSync(
    "bun",
    ["run", "release:agent:gate"],
    {
      cwd: root,
      encoding: "utf8",
      env: defaultEnv,
    },
  );
  const agentVerbose = spawnSync(
    "bun",
    ["run", "release:agent:gate", "--", "--verbose"],
    {
      cwd: root,
      encoding: "utf8",
      env: defaultEnv,
    },
  );
  const app = spawnSync(
    "bun",
    ["run", "release:app:gate"],
    {
      cwd: root,
      encoding: "utf8",
      env: appEnv,
    },
  );
  const appVerbose = spawnSync(
    "bun",
    ["run", "release:app:gate", "--", "--verbose"],
    {
      cwd: root,
      encoding: "utf8",
      env: appEnv,
    },
  );
  const rootGate = spawnSync("bun", ["run", "release:gate"], {
    cwd: root,
    encoding: "utf8",
    env: appEnv,
  });

  try {
    expect(agent.status).toBe(0);
    expect(agent.stdout).toBe("");
    expect(agentVerbose.status).toBe(0);
    expect(agentVerbose.stdout).toContain(
      `Butler Agent release gate passed: butler@${currentVersion}`,
    );
    expect(agentVerbose.stdout).toContain(`Products: Butler Agent@${currentVersion}`);
    expect(app.status).toBe(0);
    expect(app.stdout).toBe("");
    expect(appVerbose.status).toBe(0);
    expect(appVerbose.stdout).toContain(
      `App release gate passed: butler-app@${currentVersion}`,
    );
    expect(appVerbose.stdout).toContain(`Components: app@${currentVersion}`);
    expect(appVerbose.stdout).toContain(`Previous manifest: ${previousAppManifestPath}`);
    expect(rootGate.status).toBe(0);
    expect(rootGate.stdout).toBe("");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
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
  expect(rootPackage.scripts).toHaveProperty("release:agent:gate");
  expect(rootPackage.scripts).toHaveProperty("release:agent:package");
  expect(rootPackage.scripts).toHaveProperty("release:agent:smoke");
  expect(rootPackage.scripts["release:agent:gate"]).toContain(
    "deploy/agent/release-gate.ts",
  );
  expect(rootPackage.scripts["release:agent:smoke"]).toContain(
    "deploy/agent/smoke.ts",
  );
  expect(rootPackage.scripts).toHaveProperty("release:service:package");
  expect(rootPackage.scripts["release:service:package"]).toContain("release:agent:package");
  expect(rootPackage.scripts["release:agent:package"]).toContain(
    "deploy/agent/package-agent.ts",
  );
  expect(rootPackage.scripts).toHaveProperty("release:app:gate");
  expect(rootPackage.scripts).toHaveProperty("release:app:package");
  expect(rootPackage.scripts).toHaveProperty("release:app:smoke");
  expect(rootPackage.scripts["release:app:gate"]).toContain(
    "deploy/app/release-gate.ts",
  );
  expect(rootPackage.scripts["release:app:package"]).toContain(
    "deploy/app/package-app.ts",
  );
  expect(rootPackage.scripts["release:app:smoke"]).toContain(
    "deploy/app/smoke.ts",
  );
  for (const deployScript of [
    "deploy/agent/release-gate.ts",
    "deploy/agent/package-agent.ts",
    "deploy/agent/smoke.ts",
    "deploy/app/release-gate.ts",
    "deploy/app/package-app.ts",
    "deploy/app/smoke.ts",
  ]) {
    expect(existsSync(join(root, deployScript))).toBe(true);
  }
  expect(rootPackage.scripts).toHaveProperty("install:docker");
  expect(electronPackage.scripts).toHaveProperty("package:mac");
  expect(electronPackage.scripts).toHaveProperty("package:linux");
  expect(electronPackage.scripts["package:mac"]).toContain(
    "adhoc-sign-mac.mjs",
  );
  expect(electronPackage.scripts["package:mac"]).toContain(
    "normalize-mac-bundle.mjs",
  );
  const macBundleNormalizer = readText(
    join(
      root,
      "packages",
      "butler-app",
      "client",
      "electron",
      "scripts",
      "normalize-mac-bundle.mjs",
    ),
  );
  const macHelperBuilder = readText(
    join(
      root,
      "packages",
      "butler-app",
      "client",
      "electron",
      "scripts",
      "build-mac-menu-bar-helper.mjs",
    ),
  );
  const macHelperSource = readText(
    join(
      root,
      "packages",
      "butler-app",
      "client",
      "electron",
      "native",
      "menu-bar-helper.swift",
    ),
  );
  expect(macBundleNormalizer).toContain("build-mac-menu-bar-helper.mjs");
  expect(macHelperBuilder).toContain("LoginItems");
  expect(macHelperBuilder).toContain("<key>LSUIElement</key>");
  expect(macHelperBuilder).toContain("menu-bar-helper.swift");
  expect(macHelperBuilder).toContain("butler-mark-flat.png");
  expect(macHelperBuilder).toContain("swiftc");
  expect(macHelperSource).toContain("NSStatusBar.system.statusItem");
  expect(macHelperSource).toContain("setActivationPolicy(.accessory)");
  expect(macHelperSource).toContain("butler-mark-flat");
  expect(macHelperSource).toContain("menu-bar-helper.lock");
  expect(macHelperSource).toContain("flock");
  expect(macHelperSource).toContain("runningApplications");
  expect(macHelperSource).toContain("forceTerminate");
  expect(macHelperSource).toContain("--butler-new-chat");
  expect(macHelperSource).toContain("Stop Butler Agent?");
  expect(macHelperSource).toContain("Do not show this warning again");
  expect(macHelperSource).not.toContain("Quit Butler UI");
  expect(macHelperSource).not.toContain("Quit Menu Bar Helper");
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
  ).toContain('from "../../packages/butler-app/scripts/release/package-app-release.ts"');
  expect(
    readText(join(root, "tests", "smoke", "app-package-smoke.ts")),
  ).toContain("local-auth-required");
  expect(
    readText(join(root, "tests", "smoke", "app-package-smoke.ts")),
  ).toContain("standalone-home-unchanged");
  expect(
    readText(join(root, "tests", "smoke", "app-package-smoke.ts")),
  ).not.toContain("createAppServer");
  expect(
    readText(join(root, "tests", "smoke", "app-package-smoke.ts")),
  ).not.toContain("BUTLER_SMOKE_REPO_ROOT");
  expect(
    readText(join(root, "tests", "smoke", "app-package-smoke.ts")),
  ).toContain("packaged app executable");
  expect(
    readText(join(root, "tests", "smoke", "app-package-smoke.ts")),
  ).toContain("minimal-path-first-launch");
  expect(
    readText(join(root, "tests", "smoke", "app-package-smoke.ts")),
  ).toContain("host-tool-blockers-unused");
  expect(
    readText(join(root, "tests", "smoke", "app-package-smoke.ts")),
  ).toContain("BUTLER_HOST_TOOL_BLOCK_LOG");
  expect(
    readText(join(root, "tests", "smoke", "app-package-smoke.ts")),
  ).toContain("delete env.BUTLER_BUN");
  expect(
    readText(join(root, "tests", "smoke", "app-package-smoke.ts")),
  ).toContain("delete env.BUTLER_APP_BUNDLED_AGENT_DIR");
  expect(
    readText(join(root, "tests", "smoke", "app-package-smoke.ts")),
  ).toContain('join("Contents", "Resources", "bundled-agent")');
  expect(
    readText(join(root, "tests", "smoke", "app-package-smoke.ts")),
  ).toContain("packaged-resource-source");
  expect(
    readText(join(root, "tests", "smoke", "app-package-smoke.ts")),
  ).toContain("PATH: hostToolBlockBin");
  const appReleasePackager = readText(
    join(root, "packages", "butler-app", "scripts", "release", "package-app-release.ts"),
  );
  const appInstallTestEnv = readText(
    join(root, "packages", "butler-app", "scripts", "app-install-test-env.ts"),
  );
  expect(appReleasePackager).toContain("butler.update-manifest.v1");
  expect(appReleasePackager).toContain("app-release-manifest.json");
  expect(appReleasePackager).toContain("app-update-manifest.json");
  expect(appReleasePackager).toContain("prepareBundledAgentResource");
  expect(appReleasePackager).toContain("createAgentReleasePackage");
  expect(appReleasePackager).toContain('join("deploy", "agent", "package-agent.ts")');
  expect(appReleasePackager).toContain('"--json"');
  expect(appReleasePackager).not.toContain("createServiceReleasePackage");
  expect(appReleasePackager).not.toContain("currentServiceCliLauncherPlatform");
  expect(appReleasePackager).toContain("--extra-resource=");
  expect(appReleasePackager).toContain("bundled-agent");
  expect(appReleasePackager).toContain("APP_RENDERER_DIST");
  expect(appReleasePackager).toContain('join(outDir, "app-client")');
  expect(appReleasePackager).toContain("Butler app renderer dist is missing");
  expect(appReleasePackager).toContain("adhoc-sign-mac.mjs");
  expect(appReleasePackager).toContain("normalize-mac-bundle.mjs");
  expect(appReleasePackager).toContain("BUTLER_APP_PACKAGER");
  expect(appReleasePackager).toContain("appReleaseIconPath(root)");
  expect(appReleasePackager).toContain("appReleasePackagerIconPath(outDir)");
  expect(appReleasePackager).toContain("copyFileSync(iconPath, packagerIconPath)");
  expect(appReleasePackager).toContain("CFBundleIconName");
  expect(appReleasePackager).toContain("--app-bundle-id=");
  expect(appReleasePackager).toContain("createMacDmg");
  expect(appReleasePackager).toContain("symlinkSync(\"/Applications\"");
  expect(appReleasePackager).toContain("packaged mac app icon does not match Butler icon");
  expect(appReleasePackager).toContain("--ignore=^/dist($|/)");
  expect(appInstallTestEnv).toContain("createMacDmg");
  expect(appInstallTestEnv).toContain('runRequired("hdiutil"');
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

function extractTarEntryJson(artifactPath: string, entryPath: string): any {
  const result = spawnSync("tar", ["-xOf", artifactPath, entryPath], {
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

function extractTarEntryBuffer(artifactPath: string, entryPath: string): Buffer {
  const result = spawnSync("tar", ["-xOf", artifactPath, entryPath]);
  expect(result.status).toBe(0);
  return result.stdout as Buffer;
}

function extractTarEntryText(artifactPath: string, entryPath: string): string {
  const result = spawnSync("tar", ["-xOf", artifactPath, entryPath], {
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return result.stdout;
}

function tarVerboseListing(artifactPath: string): string {
  const result = spawnSync("tar", ["-tvzf", artifactPath], {
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return result.stdout;
}

function writeFakeLinuxX64Runtime(dir: string): string {
  const runtime = join(dir, "fake-linux-x64-bun");
  const bytes = Buffer.alloc(64);
  bytes[0] = 0x7f;
  bytes[1] = 0x45;
  bytes[2] = 0x4c;
  bytes[3] = 0x46;
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeUInt16LE(0x3e, 18);
  writeFileSync(runtime, bytes);
  chmodSync(runtime, 0o755);
  return runtime;
}

function writeFakeLinuxArm64Runtime(dir: string): string {
  const runtime = join(dir, "fake-linux-arm64-bun");
  const bytes = Buffer.alloc(64);
  bytes[0] = 0x7f;
  bytes[1] = 0x45;
  bytes[2] = 0x4c;
  bytes[3] = 0x46;
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeUInt16LE(0xb7, 18);
  writeFileSync(runtime, bytes);
  chmodSync(runtime, 0o755);
  return runtime;
}

function writeFakeDpkgDeb(dir: string): string {
  const runtime = join(dir, "fake-dpkg-deb");
  writeExecutableScript(runtime, `#!/bin/sh
set -eu
root="$3"
out="$4"
tar -czf "$out" -C "$root" .
`);
  return runtime;
}

function writeFakeMakepkg(dir: string): string {
  const runtime = join(dir, "fake-makepkg");
  writeExecutableScript(runtime, `#!/bin/sh
set -eu
pkgname="$(sed -n 's/^pkgname=//p' PKGBUILD)"
pkgver="$(sed -n 's/^pkgver=//p' PKGBUILD)"
tar -czf "\${pkgname}-\${pkgver}-1-x86_64.pkg.tar.zst" -C pkgroot .
`);
  return runtime;
}

function writeFakeAgentPackager(dir: string): string {
  const runtime = join(dir, "fake-agent-packager");
  writeExecutableScript(runtime, `#!/bin/sh
set -eu
out=""
artifact_name=""
platforms=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) shift; out="$1" ;;
    --artifact-name) shift; artifact_name="$1" ;;
    --cli-launcher-platform) shift; platforms="$platforms $1" ;;
  esac
  shift || true
done
mkdir -p "$out"
if [ -z "$artifact_name" ]; then
  artifact_name="butler-agent-${currentVersion}-all.tar.gz"
fi
artifact="$out/$artifact_name"
printf '%s\\n' "$platforms" > "$out/fake-agent-platforms.txt"
printf 'fake agent archive\\n' > "$artifact"
printf '{}\\n' > "$out/agent-release-manifest.json"
printf '{}\\n' > "$out/agent-update-manifest.json"
sha="$(sha256sum "$artifact" | awk '{print $1}')"
printf '{"artifactPath":"%s","releaseManifestPath":"%s","updateManifestPath":"%s","artifactName":"%s","sha256":"%s","version":"${currentVersion}"}\\n' "$artifact" "$out/agent-release-manifest.json" "$out/agent-update-manifest.json" "$artifact_name" "$sha"
`);
  return runtime;
}

function writeFakeElectronPackager(dir: string): string {
  const runtime = join(dir, "fake-electron-packager");
  writeExecutableScript(runtime, `#!/bin/sh
set -eu
out=""
extras=""
for arg in "$@"; do
  case "$arg" in
    --out=*) out="\${arg#--out=}" ;;
    --extra-resource=*) extras="$extras \${arg#--extra-resource=}" ;;
  esac
done
app="$out/Butler-linux-x64"
resources="$app/resources"
mkdir -p "$resources"
printf 'fake electron app\\n' > "$app/Butler"
printf 'fake sandbox\\n' > "$app/chrome-sandbox"
chmod 755 "$app/Butler" "$app/chrome-sandbox"
for extra in $extras; do
  name="$(basename "$extra")"
  cp -R "$extra" "$resources/$name"
done
`);
  return runtime;
}

function writeFakeDarwinArm64Runtime(dir: string): string {
  const runtime = join(dir, "fake-darwin-arm64-bun");
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeInt32LE(0x0100000c, 4);
  writeFileSync(runtime, bytes);
  chmodSync(runtime, 0o755);
  return runtime;
}

function isElfX64(bytes: Buffer): boolean {
  return (
    bytes.length >= 20 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46 &&
    bytes[4] === 2 &&
    bytes.readUInt16LE(18) === 0x3e
  );
}

function writeExecutableScript(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}
