import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  APP_AGENT_SERVICE_STATUSES,
  APP_AGENT_UPDATE_STATUSES,
  APP_BACKGROUND_SERVICE_RUNTIME_FIELDS,
  appBackgroundServiceCapability,
  type AppBackgroundServicePlatform,
  type AppBackgroundServiceV1Path,
} from "../background-service-contract.ts";

export const APP_RELEASE_COMPONENT_IDS = ["app"] as const;
export const APP_RELEASE_PLATFORMS = ["darwin-arm64", "linux-x64", "linux-arm64"] as const;
export const APP_RELEASE_BUILD_PLATFORMS = [
  ...APP_RELEASE_PLATFORMS,
  "win32-x64",
] as const;
export type AppReleaseComponentId = (typeof APP_RELEASE_COMPONENT_IDS)[number];
export type AppReleasePlatform = (typeof APP_RELEASE_BUILD_PLATFORMS)[number];
export type AppReleaseRestartPolicy = "restart-app";
export type AppReleaseUpdatePolicy = "app-user-action";
export type AppReleaseProduct = "butler-app";
export type AppReleaseGatewayProfile = "electron";
export type AppReleaseUpdaterOwner = "butler-app";
export type AppReleasePayloadFormat = "platform-app-package";
export type AppReleaseStagingPolicy = "platform-updater-cache";
export type AppReleaseActivationPolicy =
  "platform-app-update-then-versioned-app-runtime";
export type AppReleaseRollbackPolicy =
  "preserve-previous-app-managed-runtime";
export type AppReleaseServiceInstallerPackageFormat = "dmg" | "zip" | "pkg" | "deb" | "pacman" | "rpm";
export type AppOwnedDependencyId =
  | "electron-shell"
  | "renderer-assets"
  | "bootstrap-setup-ui"
  | "bundled-agent-payload"
  | "managed-runtime-payload"
  | "runtime-package-dependencies"
  | "local-setup-bridge"
  | "release-manifests"
  | "background-service-registration-metadata"
  | "app-managed-runtime-home"
  | "bundled-payload-repair-source";

export interface AppReleaseProtocolCompatibility {
  protocol: "butler.app.v1";
  minimumAppProtocol: "butler.app.v1";
  maximumAppProtocol: "butler.app.v1";
}

export interface AppReleaseIntegrityMetadata {
  digestAlgorithm: "sha256";
  digest: string | null;
  signature: string | null;
}

export interface AppOwnedDependency {
  id: AppOwnedDependencyId;
  title: string;
  requiredForFirstLaunch: boolean;
  source: "app-bundle" | "signed-butler-payload" | "app-managed-runtime-home";
  paths: string[];
  integrity: AppReleaseIntegrityMetadata;
  repairSource: "bundled-payload-repair-source" | null;
}

export interface AppRuntimePackageDependency {
  id: "managed-bun-runtime";
  path: "bundled-agent/runtime";
  requiredForFirstLaunch: true;
  repairSource: "bundled-payload-repair-source";
}

export interface AppDependencyClosureRepairSource {
  id: "bundled-payload-repair-source";
  source: "app-bundle";
  paths: string[];
  verification: "sha256";
  integrity: AppReleaseIntegrityMetadata;
}

export interface AppDependencyClosureManifest {
  schema: "butler.app-bundled-agent-dependency-closure.v1";
  product: AppReleaseProduct;
  gatewayProfile: AppReleaseGatewayProfile;
  bundledAgentVersion: string;
  payload: {
    product: "butler-agent";
    artifactName: string;
    sha256: string;
    integrity: AppReleaseIntegrityMetadata;
  };
  hostToolsRequiredForFirstLaunch: string[];
  appOwnedDependencies: AppOwnedDependency[];
  runtimePackageDependencies: AppRuntimePackageDependency[];
  repairSources: AppDependencyClosureRepairSource[];
  activation: {
    verification: "sha256-before-activation";
    target: "versioned-app-managed-runtime-home";
    rollback: "preserve-previous-app-managed-runtime";
  };
  forbiddenDefaultSetupTools: string[];
  rawTextIncluded: false;
}

export interface AppBundledAgentPayload {
  product: "butler-agent";
  profile: "agent-standalone";
  version: string;
  artifactName: string;
  resourcePath: string;
  releaseManifestPath: string;
  updateManifestPath: string;
  runtimeResolver: "packages/butler-agent/scripts/start-butler.sh";
  runtimePayload: "packages/butler-agent";
  managedRuntimePayloadPath: string;
  dependencyClosureManifestPath: string;
  protocolCompatibility: {
    protocol: "butler.agent.v1";
    minimumAgentProtocol: "butler.agent.v1";
    maximumAgentProtocol: "butler.agent.v1";
  };
  integrity: AppReleaseIntegrityMetadata;
}

export interface AppBackgroundServiceInstallerRequirement {
  platform: AppBackgroundServicePlatform;
  selectedV1Path: AppBackgroundServiceV1Path;
  installerRequired: "yes" | "no";
  packageFormats: AppReleaseServiceInstallerPackageFormat[];
  requiredDecision: string;
  allowedMechanisms: string[];
  userContext: string;
  registersUserService: boolean;
}

export interface AppBackgroundServiceReleaseCapability {
  schema: "butler.app-background-service-capability.v1";
  serviceCapable: true;
  gatewayProfile: AppReleaseGatewayProfile;
  serviceOwner: "butler-agent";
  processGroupOwner: "native-service-supervisor";
  appGatewayOwner: "background-agent-service";
  runtimePointerPath: "$BUTLER_DATA/app/runtime/agent/current.json";
  requiredRuntimeFields: string[];
  serviceStatuses: string[];
  updateStatuses: string[];
  installerRequirements: AppBackgroundServiceInstallerRequirement[];
  rawTextIncluded: false;
}

export interface AppServiceInstallerPackageArtifactMetadata {
  packageFormat: AppReleaseServiceInstallerPackageFormat;
  selectedV1Path: AppBackgroundServiceV1Path;
  serviceManager: "launchd" | "systemd-user";
  serviceDefinitionTarget: string;
  renderContractPath: string;
  launcherPath?: string;
  postInstallPath: string;
  publishedArtifactName: string | null;
  publishedSha256Name: string | null;
}

export interface AppServiceInstallerBundleMetadata {
  schema: "butler.app-service-installer-bundle.v1";
  product: AppReleaseProduct;
  gatewayProfile: AppReleaseGatewayProfile;
  resourcePath: "bundled-agent/service-installer/installer-manifest.json";
  installerRootPath: "bundled-agent/service-installer";
  servicePlatforms: AppBackgroundServicePlatform[];
  hostToolsRequiredForFirstLaunch: string[];
  packageArtifacts: AppServiceInstallerPackageArtifactMetadata[];
  rawTemplateIncluded: false;
  rawTextIncluded: false;
}

export interface AppDesktopHelperMetadata {
  schema: "butler.app-desktop-helper.v1";
  product: AppReleaseProduct;
  owner: "butler-app";
  helperMode: "background-helper-executable" | "electron-main-tray";
  defaultEnabledPlatforms: AppBackgroundServicePlatform[];
  survivesMainUiQuitPlatforms: AppBackgroundServicePlatform[];
  stopsAgentOnHelperQuit: false;
  launchArgument: "--butler-menu-bar-helper";
  quitMainUiArgument: "--butler-quit-main-ui";
  quitHelperArgument: "--butler-quit-menu-bar-helper";
  platforms: AppBackgroundServicePlatform[];
  rawTextIncluded: false;
}

export interface AppReleaseComponent {
  id: AppReleaseComponentId;
  product: AppReleaseProduct;
  name: string;
  version: string;
  versionSource: string;
  gatewayProfile: AppReleaseGatewayProfile;
  bundledAgentVersion: string;
  bundledAgentPayload: AppBundledAgentPayload;
  backgroundServiceCapability: AppBackgroundServiceReleaseCapability;
  serviceInstallerBundle: AppServiceInstallerBundleMetadata;
  desktopHelper: AppDesktopHelperMetadata;
  protocolCompatibility: AppReleaseProtocolCompatibility;
  bundledComponents: AppReleaseComponentId[];
  requiredFiles: string[];
  privateDataPatterns: string[];
  updatePolicy: AppReleaseUpdatePolicy;
  restartPolicy: AppReleaseRestartPolicy;
  updaterOwner: AppReleaseUpdaterOwner;
  payloadFormat: AppReleasePayloadFormat;
  stagingPolicy: AppReleaseStagingPolicy;
  activationPolicy: AppReleaseActivationPolicy;
  rollbackPolicy: AppReleaseRollbackPolicy;
}

export interface AppReleaseArtifact {
  product: AppReleaseProduct;
  component: AppReleaseComponentId;
  version: string;
  channel: "stable";
  platform: AppReleasePlatform;
  artifactName: string;
  downloadUrl: string | null;
  sha256: string | null;
  signature: string | null;
  bundledComponents: AppReleaseComponentId[];
  compatibleProtocol: "butler.app.v1";
  gatewayProfile: AppReleaseGatewayProfile;
  bundledAgentVersion: string;
  bundledAgentPayload: AppBundledAgentPayload;
  backgroundServiceCapability: AppBackgroundServiceReleaseCapability;
  serviceInstallerBundle: AppServiceInstallerBundleMetadata;
  desktopHelper: AppDesktopHelperMetadata;
  protocolCompatibility: AppReleaseProtocolCompatibility;
  integrity: AppReleaseIntegrityMetadata;
  updatePolicy: AppReleaseUpdatePolicy;
  restartPolicy: AppReleaseRestartPolicy;
  updaterOwner: AppReleaseUpdaterOwner;
  payloadFormat: AppReleasePayloadFormat;
  stagingPolicy: AppReleaseStagingPolicy;
  activationPolicy: AppReleaseActivationPolicy;
  rollbackPolicy: AppReleaseRollbackPolicy;
  distributionStatus: "public" | "gated";
  updateFeed: AppReleaseUpdateFeed | null;
}

export interface AppReleaseUpdateFeed {
  kind: "squirrel-windows";
  packageName: string;
  packageUrl: string;
  packageSha256: string;
  indexName: "RELEASES";
  indexUrl: string;
  indexSha256: string;
}

export interface AppReleaseManifest {
  name: "butler-app";
  product: AppReleaseProduct;
  publicProductGroups: AppReleaseProduct[];
  protocol: "butler.app.v1";
  protocolCompatibility: AppReleaseProtocolCompatibility;
  version: string;
  gatewayProfile: AppReleaseGatewayProfile;
  bundledAgentVersion: string;
  bundledAgentPayload: AppBundledAgentPayload;
  backgroundServiceCapability: AppBackgroundServiceReleaseCapability;
  serviceInstallerBundle: AppServiceInstallerBundleMetadata;
  desktopHelper: AppDesktopHelperMetadata;
  updaterOwner: AppReleaseUpdaterOwner;
  components: AppReleaseComponent[];
  artifacts: AppReleaseArtifact[];
}

export interface AppReleaseVersionBaseline {
  version?: string | null;
  bundledAgentVersion?: string | null;
}

export interface ValidateAppReleaseManifestOptions {
  previousManifest?: AppReleaseVersionBaseline | null;
  expectedPlatforms?: readonly AppReleasePlatform[];
}

export interface AppComponentVersions {
  app: string;
  bundledAgent: string;
}

const APP_RELEASE_FORBIDDEN_SERVICE_PATH_PREFIXES = [
  "bin/butler.js",
  "packages/butler-agent/",
] as const;

const APP_BUNDLED_AGENT_RESOURCE_DIR = "bundled-agent";
const APP_PACKAGED_RENDERER_DIST =
  "packages/butler-agent/resources/app-client/dist";
const APP_OWNED_DEPENDENCY_IDS: AppOwnedDependencyId[] = [
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
];
const APP_FORBIDDEN_DEFAULT_SETUP_TOOLS = [
  "bun",
  "node",
  "npm",
  "git",
  "curl",
  "wget",
  "unzip",
  "tar",
  "brew",
  "apt",
  "dnf",
  "yum",
  "pacman",
  "terminal",
  "administrator",
] as const;

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readAppComponentVersions(root: string): AppComponentVersions {
  const electronPkg = readJson(
    join(root, "packages", "butler-app", "client", "electron", "package.json"),
  );
  const agentVersionPath = join(root, "VERSION");
  return {
    app: String(electronPkg.version ?? ""),
    bundledAgent: existsSync(agentVersionPath)
      ? readFileSync(agentVersionPath, "utf8").trim()
      : String(electronPkg.version ?? ""),
  };
}

export function createAppReleaseManifest(
  root: string,
  platforms: readonly AppReleasePlatform[] = APP_RELEASE_PLATFORMS,
): AppReleaseManifest {
  const versions = readAppComponentVersions(root);
  const bundledAgentPayload = createBundledAgentPayloadMetadata(versions.bundledAgent);
  const backgroundServiceCapability = createAppBackgroundServiceReleaseCapability(
    platforms,
  );
  const serviceInstallerBundle = createAppServiceInstallerBundleMetadata(
    platforms,
    versions.app,
  );
  const desktopHelper = createAppDesktopHelperMetadata(platforms);
  const protocolCompatibility: AppReleaseProtocolCompatibility = {
    protocol: "butler.app.v1",
    minimumAppProtocol: "butler.app.v1",
    maximumAppProtocol: "butler.app.v1",
  };
  const appFiles = [
    "packages/butler-app/README.md",
    "packages/butler-app/client/README.md",
    "packages/butler-app/client/electron/package.json",
    "packages/butler-app/client/electron/main.mjs",
    "packages/butler-app/client/electron/preload.cjs",
    "packages/butler-app/client/electron/scripts",
    "packages/butler-app/client/electron/assets/butler-icon.svg",
    "packages/butler-app/client/electron/assets/butler.icon",
    "packages/butler-app/client/electron/assets/butler.icns",
    "packages/butler-app/client/electron/assets/butler.ico",
    "packages/butler-app/client/electron/assets/butler-mac.png",
    "packages/butler-app/client/electron/assets/butler-mark-flat.png",
    "packages/butler-app/client/electron/assets/butler-mark-flat-white.png",
    "packages/butler-app/client/electron/assets/icon.png",
    "packages/butler-app/client/ui/package.json",
    "packages/butler-app/client/ui/index.html",
    "packages/butler-app/client/ui/src",
    "packages/butler-app/scripts/release/release-gate.ts",
    "packages/butler-app/scripts/release/manifest.ts",
  ];
  const components: AppReleaseComponent[] = [
    {
      id: "app",
      product: "butler-app",
      name: "Butler App",
      version: versions.app,
      versionSource: "packages/butler-app/client/electron/package.json",
      gatewayProfile: "electron",
      bundledAgentVersion: versions.bundledAgent,
      bundledAgentPayload,
      backgroundServiceCapability,
      serviceInstallerBundle,
      desktopHelper,
      protocolCompatibility,
      bundledComponents: ["app"],
      requiredFiles: appFiles,
      privateDataPatterns: [],
      updatePolicy: "app-user-action",
      restartPolicy: "restart-app",
      updaterOwner: "butler-app",
      payloadFormat: "platform-app-package",
      stagingPolicy: "platform-updater-cache",
      activationPolicy: "platform-app-update-then-versioned-app-runtime",
      rollbackPolicy: "preserve-previous-app-managed-runtime",
    },
  ];
  return {
    name: "butler-app",
    product: "butler-app",
    publicProductGroups: ["butler-app"],
    protocol: "butler.app.v1",
    protocolCompatibility,
    version: versions.app,
    gatewayProfile: "electron",
    bundledAgentVersion: versions.bundledAgent,
    bundledAgentPayload,
    backgroundServiceCapability,
    serviceInstallerBundle,
    desktopHelper,
    updaterOwner: "butler-app",
    components,
    artifacts: components.flatMap((component) =>
      platforms.map((platform) => ({
        product: "butler-app",
        component: component.id,
        version: component.version,
        channel: "stable",
        platform,
        artifactName: artifactName(component.id, component.version, platform),
        downloadUrl: null,
        sha256: null,
        signature: null,
        bundledComponents: component.bundledComponents,
        compatibleProtocol: "butler.app.v1",
        gatewayProfile: "electron",
        bundledAgentVersion: versions.bundledAgent,
        bundledAgentPayload: createBundledAgentPayloadMetadata(
          versions.bundledAgent,
          null,
          platform,
        ),
        backgroundServiceCapability: createAppBackgroundServiceReleaseCapability([platform]),
        serviceInstallerBundle: createAppServiceInstallerBundleMetadata([
          platform,
        ], component.version),
        desktopHelper: createAppDesktopHelperMetadata([platform]),
        protocolCompatibility,
        integrity: {
          digestAlgorithm: "sha256",
          digest: null,
          signature: null,
        },
        updatePolicy: component.updatePolicy,
        restartPolicy: component.restartPolicy,
        updaterOwner: "butler-app",
        payloadFormat: "platform-app-package",
        stagingPolicy: "platform-updater-cache",
        activationPolicy: "platform-app-update-then-versioned-app-runtime",
        rollbackPolicy: "preserve-previous-app-managed-runtime",
        distributionStatus: platform === "win32-x64" ? "gated" : "public",
        updateFeed: null,
      })),
    ),
  };
}

export function createAppBackgroundServiceReleaseCapability(
  platforms: readonly AppReleasePlatform[] = APP_RELEASE_PLATFORMS,
): AppBackgroundServiceReleaseCapability {
  const installerPlatforms = uniqueReleasePlatformsByServicePlatform(platforms);
  return {
    schema: "butler.app-background-service-capability.v1",
    serviceCapable: true,
    gatewayProfile: "electron",
    serviceOwner: "butler-agent",
    processGroupOwner: "native-service-supervisor",
    appGatewayOwner: "background-agent-service",
    runtimePointerPath: "$BUTLER_DATA/app/runtime/agent/current.json",
    requiredRuntimeFields: [...APP_BACKGROUND_SERVICE_RUNTIME_FIELDS],
    serviceStatuses: [...APP_AGENT_SERVICE_STATUSES],
    updateStatuses: [...APP_AGENT_UPDATE_STATUSES],
    installerRequirements: installerPlatforms.map((platform) =>
      appServiceInstallerRequirementForPlatform(platform),
    ),
    rawTextIncluded: false,
  };
}

export function createAppServiceInstallerBundleMetadata(
  platforms: readonly AppReleasePlatform[] = APP_RELEASE_PLATFORMS,
  version: string | null = null,
): AppServiceInstallerBundleMetadata {
  const packagePlatforms = uniqueReleasePlatformsByServicePlatform(platforms);
  return {
    schema: "butler.app-service-installer-bundle.v1",
    product: "butler-app",
    gatewayProfile: "electron",
    resourcePath: "bundled-agent/service-installer/installer-manifest.json",
    installerRootPath: "bundled-agent/service-installer",
    servicePlatforms: uniqueServicePlatforms(platforms),
    hostToolsRequiredForFirstLaunch: [],
    packageArtifacts: packagePlatforms.flatMap((platform) =>
      serviceInstallerPackageArtifactsForPlatform(platform, version),
    ),
    rawTemplateIncluded: false,
    rawTextIncluded: false,
  };
}

export function createAppDesktopHelperMetadata(
  platforms: readonly AppReleasePlatform[] = APP_RELEASE_PLATFORMS,
): AppDesktopHelperMetadata {
  const defaultEnabledPlatforms = persistentMenuBarHelperDefaultPlatforms(platforms);
  return {
    schema: "butler.app-desktop-helper.v1",
    product: "butler-app",
    owner: "butler-app",
    helperMode: "electron-main-tray",
    defaultEnabledPlatforms,
    survivesMainUiQuitPlatforms: defaultEnabledPlatforms,
    stopsAgentOnHelperQuit: false,
    launchArgument: "--butler-menu-bar-helper",
    quitMainUiArgument: "--butler-quit-main-ui",
    quitHelperArgument: "--butler-quit-menu-bar-helper",
    platforms: uniqueServicePlatforms(platforms),
    rawTextIncluded: false,
  };
}

function persistentMenuBarHelperDefaultPlatforms(
  platforms: readonly AppReleasePlatform[],
): AppBackgroundServicePlatform[] {
  void platforms;
  return [];
}

function appServiceInstallerRequirementForPlatform(
  releasePlatform: AppReleasePlatform,
): AppBackgroundServiceInstallerRequirement {
  const servicePlatform = servicePlatformForReleasePlatform(releasePlatform);
  const capability = appBackgroundServiceCapability(servicePlatform);
  const selectedV1Path = selectedInstallerV1Path(servicePlatform);
  if (["darwin", "linux", "win32"].includes(servicePlatform)) {
    return {
      platform: servicePlatform,
      selectedV1Path,
      installerRequired: "no",
      packageFormats: servicePlatform === "darwin"
        ? ["dmg", "zip"]
        : servicePlatform === "linux"
        ? ["deb", "pacman"]
        : [],
      requiredDecision: "Butler App owns the Agent only while the App is running.",
      allowedMechanisms: ["app-foreground-child"],
      userContext: "signed-in desktop user",
      registersUserService: false,
    };
  }
  return {
    platform: servicePlatform,
    selectedV1Path,
    installerRequired: "yes",
    packageFormats: serviceInstallerPackageFormats(servicePlatform),
    requiredDecision: capability.requiredDecision,
    allowedMechanisms: [...capability.allowedMechanisms],
    userContext: capability.userContext,
    registersUserService: true,
  };
}

function uniqueServicePlatforms(
  platforms: readonly AppReleasePlatform[],
): AppBackgroundServicePlatform[] {
  return [...new Set(platforms.map(servicePlatformForReleasePlatform))];
}

function uniqueReleasePlatformsByServicePlatform(
  platforms: readonly AppReleasePlatform[],
): AppReleasePlatform[] {
  const seen = new Set<AppBackgroundServicePlatform>();
  const result: AppReleasePlatform[] = [];
  for (const platform of platforms) {
    const servicePlatform = servicePlatformForReleasePlatform(platform);
    if (seen.has(servicePlatform)) continue;
    seen.add(servicePlatform);
    result.push(platform);
  }
  return result;
}

function servicePlatformForReleasePlatform(
  platform: AppReleasePlatform,
): AppBackgroundServicePlatform {
  if (platform.startsWith("darwin-")) return "darwin";
  if (platform.startsWith("linux-")) return "linux";
  if (platform === "win32-x64") return "win32";
  throw new Error(`unsupported App service release platform: ${platform}`);
}

function selectedInstallerV1Path(
  platform: AppBackgroundServicePlatform,
): AppBackgroundServiceV1Path {
  if (platform === "darwin") return "macos-app-foreground";
  if (platform === "linux") return "linux-app-foreground";
  if (platform === "win32") return "windows-app-foreground";
  throw new Error(`unsupported App service platform: ${platform}`);
}

function serviceInstallerPackageFormats(
  platform: AppBackgroundServicePlatform,
): AppReleaseServiceInstallerPackageFormat[] {
  if (platform === "darwin") return ["dmg", "zip"];
  if (platform === "linux") return ["deb", "pacman"];
  if (platform === "win32") return [];
  throw new Error(`unsupported App service installer platform: ${platform}`);
}

function serviceInstallerPackageArtifactsForPlatform(
  releasePlatform: AppReleasePlatform,
  version: string | null,
): AppServiceInstallerPackageArtifactMetadata[] {
  const platform = servicePlatformForReleasePlatform(releasePlatform);
  if (platform === "darwin") {
    void version;
    return [];
  }
  if (platform === "linux") {
    void version;
    return [];
  }
  if (platform === "win32") {
    void version;
    return [];
  }
  throw new Error(`unsupported App service installer package artifact platform: ${platform}`);
}

function createBundledAgentPayloadMetadata(
  version: string,
  digest: string | null = null,
  platform: AppReleasePlatform | "all" = "all",
): AppBundledAgentPayload {
  const artifactName = `butler-agent-${version}-${platform}.tar.gz`;
  return {
    product: "butler-agent",
    profile: "agent-standalone",
    version,
    artifactName,
    resourcePath: `${APP_BUNDLED_AGENT_RESOURCE_DIR}/${artifactName}`,
    releaseManifestPath: `${APP_BUNDLED_AGENT_RESOURCE_DIR}/agent-release-manifest.json`,
    updateManifestPath: `${APP_BUNDLED_AGENT_RESOURCE_DIR}/agent-update-manifest.json`,
    runtimeResolver: "packages/butler-agent/scripts/start-butler.sh",
    runtimePayload: "packages/butler-agent",
    managedRuntimePayloadPath: `${APP_BUNDLED_AGENT_RESOURCE_DIR}/runtime`,
    dependencyClosureManifestPath: `${APP_BUNDLED_AGENT_RESOURCE_DIR}/dependency-closure.json`,
    protocolCompatibility: {
      protocol: "butler.agent.v1",
      minimumAgentProtocol: "butler.agent.v1",
      maximumAgentProtocol: "butler.agent.v1",
    },
    integrity: {
      digestAlgorithm: "sha256",
      digest,
      signature: null,
    },
  };
}

export function createAppDependencyClosureManifest(input: {
  bundledAgentVersion: string;
  bundledAgentArtifactName: string;
  bundledAgentSha256: string;
  releaseManifestSha256: string;
  updateManifestSha256: string;
  managedRuntimeSha256: string;
  backgroundServiceRegistrationMetadataSha256: string;
  releaseManifestsSha256: string;
  runtimePackageDependenciesSha256: string;
  repairSourceSha256: string;
}): AppDependencyClosureManifest {
  const payloadIntegrity: AppReleaseIntegrityMetadata = {
    digestAlgorithm: "sha256",
    digest: input.bundledAgentSha256,
    signature: null,
  };
  const managedRuntimeIntegrity = sha256Integrity(input.managedRuntimeSha256);
  const runtimePackageDependenciesIntegrity = sha256Integrity(
    input.runtimePackageDependenciesSha256,
  );
  const releaseManifestsIntegrity = sha256Integrity(input.releaseManifestsSha256);
  const repairSourceIntegrity = sha256Integrity(input.repairSourceSha256);
  const repairSource: AppDependencyClosureRepairSource = {
    id: "bundled-payload-repair-source",
    source: "app-bundle",
    paths: [
      `bundled-agent/${input.bundledAgentArtifactName}`,
      "bundled-agent/agent-release-manifest.json",
      "bundled-agent/agent-update-manifest.json",
      "bundled-agent/runtime",
      "bundled-agent/background-service-capability.json",
      "bundled-agent/background-service-registration.json",
      "bundled-agent/service-installer",
    ],
    verification: "sha256",
    integrity: repairSourceIntegrity,
  };
  return {
    schema: "butler.app-bundled-agent-dependency-closure.v1",
    product: "butler-app",
    gatewayProfile: "electron",
    bundledAgentVersion: input.bundledAgentVersion,
    payload: {
      product: "butler-agent",
      artifactName: input.bundledAgentArtifactName,
      sha256: input.bundledAgentSha256,
      integrity: payloadIntegrity,
    },
    hostToolsRequiredForFirstLaunch: [],
    appOwnedDependencies: [
      ownedDependency("electron-shell", "Electron shell", [
        "packages/butler-app/client/electron/package.json",
        "packages/butler-app/client/electron/main.mjs",
        "packages/butler-app/client/electron/preload.cjs",
      ], null),
      ownedDependency("renderer-assets", "Renderer assets", [
        `bundled-agent/${input.bundledAgentArtifactName}!${APP_PACKAGED_RENDERER_DIST}`,
        `bundled-agent/${input.bundledAgentArtifactName}!${APP_PACKAGED_RENDERER_DIST}/index.html`,
      ], "bundled-payload-repair-source", payloadIntegrity),
      ownedDependency("bootstrap-setup-ui", "Bootstrap setup UI", [
        `bundled-agent/${input.bundledAgentArtifactName}!${APP_PACKAGED_RENDERER_DIST}`,
      ], "bundled-payload-repair-source", payloadIntegrity),
      ownedDependency("bundled-agent-payload", "Bundled Butler Agent payload", [
        `bundled-agent/${input.bundledAgentArtifactName}`,
      ], "bundled-payload-repair-source", payloadIntegrity),
      ownedDependency("managed-runtime-payload", "Managed runtime payload", [
        "bundled-agent/runtime",
        "bundled-agent/runtime/bun-version",
        "bundled-agent/runtime/bin/bun",
      ], "bundled-payload-repair-source", managedRuntimeIntegrity),
      ownedDependency("runtime-package-dependencies", "Resolved runtime package dependencies", [
        `bundled-agent/${input.bundledAgentArtifactName}`,
        "bundled-agent/runtime",
      ], "bundled-payload-repair-source", runtimePackageDependenciesIntegrity),
      ownedDependency("local-setup-bridge", "Local setup bridge", [
        "packages/butler-app/client/electron/setup-bridge.mjs",
        "packages/butler-app/client/electron/app-agent-supervisor.mjs",
      ], null),
      ownedDependency("release-manifests", "Release manifests", [
        "bundled-agent/agent-release-manifest.json",
        "bundled-agent/agent-update-manifest.json",
      ], "bundled-payload-repair-source", releaseManifestsIntegrity),
      ownedDependency("background-service-registration-metadata", "Background service registration metadata", [
        "bundled-agent/background-service-capability.json",
        "bundled-agent/background-service-registration.json",
        "bundled-agent/service-installer",
      ], "bundled-payload-repair-source", sha256Integrity(input.backgroundServiceRegistrationMetadataSha256)),
      ownedDependency("app-managed-runtime-home", "App-managed runtime home layout", [
        "$BUTLER_DATA/app/runtime/agent",
      ], null),
      ownedDependency("bundled-payload-repair-source", "Bundled payload repair source", repairSource.paths, null, repairSourceIntegrity),
    ],
    runtimePackageDependencies: [
      {
        id: "managed-bun-runtime",
        path: "bundled-agent/runtime",
        requiredForFirstLaunch: true,
        repairSource: "bundled-payload-repair-source",
      },
    ],
    repairSources: [repairSource],
    activation: {
      verification: "sha256-before-activation",
      target: "versioned-app-managed-runtime-home",
      rollback: "preserve-previous-app-managed-runtime",
    },
    forbiddenDefaultSetupTools: [...APP_FORBIDDEN_DEFAULT_SETUP_TOOLS],
    rawTextIncluded: false,
  };
}

function sha256Integrity(digest: string): AppReleaseIntegrityMetadata {
  return {
    digestAlgorithm: "sha256",
    digest,
    signature: null,
  };
}

function ownedDependency(
  id: AppOwnedDependencyId,
  title: string,
  paths: string[],
  repairSource: "bundled-payload-repair-source" | null,
  integrity: AppReleaseIntegrityMetadata = {
    digestAlgorithm: "sha256",
    digest: null,
    signature: null,
  },
): AppOwnedDependency {
  return {
    id,
    title,
    requiredForFirstLaunch: true,
    source: id === "app-managed-runtime-home"
      ? "app-managed-runtime-home"
      : id === "background-service-registration-metadata"
        ? "app-bundle"
      : repairSource
        ? "signed-butler-payload"
        : "app-bundle",
    paths,
    integrity,
    repairSource,
  };
}

export function validateAppDependencyClosureManifest(
  manifest: AppDependencyClosureManifest,
): string[] {
  const issues: string[] = [];
  if (manifest.schema !== "butler.app-bundled-agent-dependency-closure.v1") {
    issues.push("dependency closure schema mismatch");
  }
  if (manifest.product !== "butler-app") {
    issues.push("dependency closure product must be butler-app");
  }
  if (manifest.gatewayProfile !== "electron") {
    issues.push("dependency closure gateway profile must be electron");
  }
  if (manifest.hostToolsRequiredForFirstLaunch.length > 0) {
    issues.push("dependency closure must not require host first-launch tools");
  }
  if (manifest.payload?.product !== "butler-agent") {
    issues.push("dependency closure payload product must be butler-agent");
  }
  if (!manifest.payload?.artifactName?.trim()) {
    issues.push("dependency closure bundled Agent payload artifact is required");
  }
  if (!manifest.payload?.sha256?.trim()) {
    issues.push("dependency closure bundled Agent payload sha256 is required");
  }
  if (
    manifest.payload?.integrity?.digestAlgorithm !== "sha256" ||
    !manifest.payload?.integrity?.digest?.trim()
  ) {
    issues.push("dependency closure bundled Agent payload digest is required");
  }
  const dependencyIds = new Set(manifest.appOwnedDependencies.map((item) => item.id));
  for (const id of APP_OWNED_DEPENDENCY_IDS) {
    if (!dependencyIds.has(id)) {
      issues.push(`dependency closure missing app-owned dependency: ${id}`);
    }
  }
  const rendererAssets = manifest.appOwnedDependencies.find((item) =>
    item.id === "renderer-assets",
  );
  if (
    rendererAssets?.source !== "signed-butler-payload" ||
    !rendererAssets.paths.some((path) => path.includes(APP_PACKAGED_RENDERER_DIST))
  ) {
    issues.push("dependency closure renderer assets must come from packaged Agent app-client dist");
  }
  const bootstrapSetup = manifest.appOwnedDependencies.find((item) =>
    item.id === "bootstrap-setup-ui",
  );
  if (
    bootstrapSetup?.source !== "signed-butler-payload" ||
    !bootstrapSetup.paths.some((path) => path.includes(APP_PACKAGED_RENDERER_DIST))
  ) {
    issues.push("dependency closure bootstrap setup UI must come from packaged Agent app-client dist");
  }
  for (const dependency of manifest.appOwnedDependencies) {
    if (!dependency.paths.length) {
      issues.push(`dependency closure ${dependency.id} must list paths`);
    }
    if (
      dependency.source === "signed-butler-payload" &&
      (
        dependency.integrity?.digestAlgorithm !== "sha256" ||
        !dependency.integrity?.digest?.trim()
      )
    ) {
      issues.push(`dependency closure ${dependency.id} digest is required`);
    }
  }
  if (!manifest.runtimePackageDependencies.some((item) =>
    item.id === "managed-bun-runtime" &&
    item.path === "bundled-agent/runtime" &&
    item.requiredForFirstLaunch === true,
  )) {
    issues.push("dependency closure managed runtime dependency is required");
  }
  const managedRuntime = manifest.appOwnedDependencies.find((item) =>
    item.id === "managed-runtime-payload",
  );
  if (!managedRuntime?.paths.includes("bundled-agent/runtime/bin/bun")) {
    issues.push("dependency closure managed runtime must include bundled Bun executable");
  }
  if (!manifest.repairSources.some((item) =>
    item.id === "bundled-payload-repair-source" &&
    item.source === "app-bundle" &&
    item.verification === "sha256" &&
    item.paths.length > 0 &&
    item.integrity?.digestAlgorithm === "sha256" &&
    Boolean(item.integrity?.digest?.trim()),
  )) {
    issues.push("dependency closure repair source is required");
  }
  if (
    manifest.activation?.verification !== "sha256-before-activation" ||
    manifest.activation?.target !== "versioned-app-managed-runtime-home" ||
    manifest.activation?.rollback !== "preserve-previous-app-managed-runtime"
  ) {
    issues.push("dependency closure activation policy is invalid");
  }
  if (manifest.rawTextIncluded !== false) {
    issues.push("dependency closure must not include raw text payloads");
  }
  return issues;
}

export function validateAppReleaseManifest(
  root: string,
  manifest = createAppReleaseManifest(root),
  options: ValidateAppReleaseManifestOptions = {},
): string[] {
  const issues: string[] = [];
  const versions = readAppComponentVersions(root);
  const expectedPlatforms = options.expectedPlatforms ?? APP_RELEASE_PLATFORMS;
  if (manifest.name !== "butler-app")
    issues.push("app release manifest name must be butler-app");
  if (manifest.product !== "butler-app")
    issues.push("app release product must be butler-app");
  if (!sameComponentSet(manifest.publicProductGroups ?? [], ["butler-app"])) {
    issues.push("app release public product groups must contain only butler-app");
  }
  if (manifest.protocol !== "butler.app.v1")
    issues.push("app release protocol must be butler.app.v1");
  validateProtocolCompatibility("app release manifest", manifest.protocolCompatibility, issues);
  if (manifest.gatewayProfile !== "electron")
    issues.push("app release gateway profile must be electron");
  if (manifest.bundledAgentVersion !== versions.bundledAgent)
    issues.push("app release bundled agent version mismatch");
  validateBundledAgentPayload(
    "app release bundled Agent payload",
    manifest.bundledAgentPayload,
    versions.bundledAgent,
    issues,
  );
  validateAppBackgroundServiceReleaseCapability(
    "app release background service capability",
    manifest.backgroundServiceCapability,
    expectedPlatforms,
    issues,
  );
  validateAppServiceInstallerBundle(
    "app release service installer bundle",
    manifest.serviceInstallerBundle,
    expectedPlatforms,
    manifest.version,
    issues,
  );
  validateAppDesktopHelper(
    "app release desktop helper",
    manifest.desktopHelper,
    expectedPlatforms,
    issues,
  );
  if (manifest.updaterOwner !== "butler-app")
    issues.push("app release updater owner must be butler-app");
  if (!manifest.version || manifest.version !== versions.app) {
    issues.push("app package version mismatch");
  }
  issues.push(...validateAppReleaseVersionCoupling(manifest, options.previousManifest));
  validateComponents(root, manifest, versions, expectedPlatforms, issues);
  validateArtifacts(manifest, expectedPlatforms, issues);
  return issues;
}

export function validateAppReleaseVersionCoupling(
  current: AppReleaseVersionBaseline,
  previous?: AppReleaseVersionBaseline | null,
): string[] {
  if (!previous) return [];
  const currentVersion = current.version?.trim();
  const currentBundledAgentVersion = current.bundledAgentVersion?.trim();
  const previousVersion = previous.version?.trim();
  const previousBundledAgentVersion = previous.bundledAgentVersion?.trim();
  if (!currentVersion || !currentBundledAgentVersion || !previousVersion) {
    return [
      "app release version coupling requires app version and bundled Agent version",
    ];
  }
  if (!previousBundledAgentVersion) {
    return currentVersion === previousVersion
      ? [
          "app release version must change when previous bundled Agent version is unavailable",
        ]
      : [];
  }
  if (
    currentBundledAgentVersion !== previousBundledAgentVersion &&
    currentVersion === previousVersion
  ) {
    return ["app release version must change when bundled Agent version changes"];
  }
  return [];
}

function artifactName(
  _component: AppReleaseComponentId,
  version: string,
  platform: AppReleasePlatform,
): string {
  if (platform === "win32-x64") {
    return "butler_setup.msi";
  }
  const extension = platform === "darwin-arm64"
    ? "dmg"
    : "deb";
  return `butler-app-${version}-${platform}.${extension}`;
}

function validateRequiredFiles(
  root: string,
  files: string[],
  issues: string[],
): void {
  for (const file of files) {
    if (!existsSync(join(root, file))) {
      issues.push(`missing required app release file: ${file}`);
    }
  }
}

function validatePrivatePatterns(
  root: string,
  patterns: string[],
  issues: string[],
): void {
  for (const pattern of patterns) {
    if (existsSync(join(root, pattern))) {
      issues.push(
        `private data path must not be packaged from app release: ${pattern}`,
      );
    }
  }
}

function validateComponents(
  root: string,
  manifest: AppReleaseManifest,
  versions: AppComponentVersions,
  expectedPlatforms: readonly AppReleasePlatform[],
  issues: string[],
): void {
  const components = new Map<AppReleaseComponentId, AppReleaseComponent>();
  for (const component of manifest.components) {
    if (!APP_RELEASE_COMPONENT_IDS.includes(component.id)) {
      issues.push(`unknown app release component: ${component.id}`);
      continue;
    }
    if (components.has(component.id)) {
      issues.push(`duplicate app release component: ${component.id}`);
    }
    components.set(component.id, component);
    if (component.product !== "butler-app") {
      issues.push(`component ${component.id} product must be butler-app`);
    }
    if (component.version !== versions.app) {
      issues.push(`component ${component.id} version source mismatch`);
    }
    if (component.gatewayProfile !== "electron") {
      issues.push(`component ${component.id} gateway profile must be electron`);
    }
    if (component.bundledAgentVersion !== versions.bundledAgent) {
      issues.push(`component ${component.id} bundled agent version mismatch`);
    }
    validateBundledAgentPayload(
      `component ${component.id} bundled Agent payload`,
      component.bundledAgentPayload,
      versions.bundledAgent,
      issues,
    );
    validateAppBackgroundServiceReleaseCapability(
      `component ${component.id} background service capability`,
      component.backgroundServiceCapability,
      expectedPlatforms,
      issues,
    );
    validateAppServiceInstallerBundle(
      `component ${component.id} service installer bundle`,
      component.serviceInstallerBundle,
      expectedPlatforms,
      component.version,
      issues,
    );
    validateAppDesktopHelper(
      `component ${component.id} desktop helper`,
      component.desktopHelper,
      expectedPlatforms,
      issues,
    );
    validateProtocolCompatibility(
      `component ${component.id}`,
      component.protocolCompatibility,
      issues,
    );
    validateAppOperationMetadata(`component ${component.id}`, component, issues);
    validateRequiredFiles(root, component.requiredFiles, issues);
    validateNoServiceInternals(component.requiredFiles, issues);
    validatePrivatePatterns(root, component.privateDataPatterns, issues);
    if (!sameComponentSet(component.bundledComponents, ["app"])) {
      issues.push("app component must not bundle service or gateway host");
    }
  }
  for (const id of APP_RELEASE_COMPONENT_IDS) {
    if (!components.has(id))
      issues.push(`missing app release component: ${id}`);
  }
}

function validateNoServiceInternals(files: string[], issues: string[]): void {
  for (const file of files) {
    if (
      APP_RELEASE_FORBIDDEN_SERVICE_PATH_PREFIXES.some(
        (prefix) => file === prefix || file.startsWith(prefix),
      )
    ) {
      issues.push(
        `app release required file must not include service internals: ${file}`,
      );
    }
  }
}

function validateArtifacts(
  manifest: AppReleaseManifest,
  expectedPlatforms: readonly AppReleasePlatform[],
  issues: string[],
): void {
  const artifactComponents = new Set<AppReleaseComponentId>();
  const artifactPlatforms = new Map<AppReleaseComponentId, Set<string>>();
  for (const artifact of manifest.artifacts) {
    if (!APP_RELEASE_COMPONENT_IDS.includes(artifact.component)) {
      issues.push(
        `unknown app release artifact component: ${artifact.component}`,
      );
      continue;
    }
    artifactComponents.add(artifact.component);
    if (artifact.product !== "butler-app") {
      issues.push(`artifact ${artifact.component} product must be butler-app`);
    }
    if (!(APP_RELEASE_BUILD_PLATFORMS as readonly string[]).includes(artifact.platform)) {
      issues.push(`unknown app release artifact platform: ${artifact.platform}`);
      continue;
    }
    if (!expectedPlatforms.includes(artifact.platform)) {
      issues.push(`unexpected app release artifact platform: ${artifact.platform}`);
      continue;
    }
    const platforms = artifactPlatforms.get(artifact.component) ?? new Set();
    if (platforms.has(artifact.platform)) {
      issues.push(
        `duplicate app release artifact platform: ${artifact.component}/${artifact.platform}`,
      );
    }
    platforms.add(artifact.platform);
    artifactPlatforms.set(artifact.component, platforms);
    const component = manifest.components.find(
      (item) => item.id === artifact.component,
    );
    if (!component) continue;
    if (artifact.version !== component.version) {
      issues.push(`artifact ${artifact.component} version mismatch`);
    }
    if (artifact.gatewayProfile !== "electron") {
      issues.push(`artifact ${artifact.component} gateway profile must be electron`);
    }
    if (artifact.bundledAgentVersion !== manifest.bundledAgentVersion) {
      issues.push(`artifact ${artifact.component} bundled agent version mismatch`);
    }
    validateBundledAgentPayload(
      `artifact ${artifact.component} bundled Agent payload`,
      artifact.bundledAgentPayload,
      manifest.bundledAgentVersion,
      issues,
      artifact.platform,
    );
    validateAppBackgroundServiceReleaseCapability(
      `artifact ${artifact.component} background service capability`,
      artifact.backgroundServiceCapability,
      [artifact.platform],
      issues,
    );
    validateAppServiceInstallerBundle(
      `artifact ${artifact.component} service installer bundle`,
      artifact.serviceInstallerBundle,
      [artifact.platform],
      artifact.version,
      issues,
    );
    validateAppDesktopHelper(
      `artifact ${artifact.component} desktop helper`,
      artifact.desktopHelper,
      [artifact.platform],
      issues,
    );
    validateProtocolCompatibility(
      `artifact ${artifact.component}`,
      artifact.protocolCompatibility,
      issues,
    );
    validateArtifactIntegrity(`artifact ${artifact.component}`, artifact.integrity, issues);
    validateAppOperationMetadata(`artifact ${artifact.component}`, artifact, issues);
    if (
      !sameComponentSet(artifact.bundledComponents, component.bundledComponents)
    ) {
      issues.push(`artifact ${artifact.component} bundled component mismatch`);
    }
    if (!sameComponentSet(artifact.bundledComponents, ["app"])) {
      issues.push("app artifact must not bundle service or gateway host");
    }
    if (!artifact.artifactName.trim()) {
      issues.push(`artifact ${artifact.component} must have an artifact name`);
    }
    const expectedDistributionStatus = artifact.platform === "win32-x64"
      ? "gated"
      : "public";
    if (artifact.distributionStatus !== expectedDistributionStatus) {
      issues.push(
        `artifact ${artifact.component}/${artifact.platform} distribution status must be ${expectedDistributionStatus}`,
      );
    }
  }
  for (const id of APP_RELEASE_COMPONENT_IDS) {
    if (!artifactComponents.has(id)) {
      issues.push(`missing app release artifact: ${id}`);
    }
    const platforms = artifactPlatforms.get(id) ?? new Set();
    for (const platform of expectedPlatforms) {
      if (!platforms.has(platform)) {
        issues.push(`missing app release artifact platform: ${id}/${platform}`);
      }
    }
  }
}

function validateBundledAgentPayload(
  label: string,
  payload: AppBundledAgentPayload | undefined,
  expectedVersion: string,
  issues: string[],
  expectedPlatform: AppReleasePlatform | "all" = "all",
): void {
  if (!payload) {
    issues.push(`${label} metadata is required`);
    return;
  }
  if (payload.product !== "butler-agent") {
    issues.push(`${label} product must be butler-agent`);
  }
  if (payload.profile !== "agent-standalone") {
    issues.push(`${label} profile must be agent-standalone`);
  }
  if (payload.version !== expectedVersion) {
    issues.push(`${label} version mismatch`);
  }
  if (payload.artifactName !== `butler-agent-${expectedVersion}-${expectedPlatform}.tar.gz`) {
    issues.push(`${label} artifact name mismatch`);
  }
  if (payload.resourcePath !== `bundled-agent/${payload.artifactName}`) {
    issues.push(`${label} resource path mismatch`);
  }
  if (payload.releaseManifestPath !== "bundled-agent/agent-release-manifest.json") {
    issues.push(`${label} release manifest path mismatch`);
  }
  if (payload.updateManifestPath !== "bundled-agent/agent-update-manifest.json") {
    issues.push(`${label} update manifest path mismatch`);
  }
  if (payload.dependencyClosureManifestPath !== "bundled-agent/dependency-closure.json") {
    issues.push(`${label} dependency closure path mismatch`);
  }
  if (payload.managedRuntimePayloadPath !== "bundled-agent/runtime") {
    issues.push(`${label} managed runtime path mismatch`);
  }
  if (payload.runtimeResolver !== "packages/butler-agent/scripts/start-butler.sh") {
    issues.push(`${label} runtime resolver mismatch`);
  }
  if (payload.runtimePayload !== "packages/butler-agent") {
    issues.push(`${label} runtime payload mismatch`);
  }
  if (
    payload.protocolCompatibility?.protocol !== "butler.agent.v1" ||
    payload.protocolCompatibility?.minimumAgentProtocol !== "butler.agent.v1" ||
    payload.protocolCompatibility?.maximumAgentProtocol !== "butler.agent.v1"
  ) {
    issues.push(`${label} protocol compatibility must be butler.agent.v1`);
  }
  validateArtifactIntegrity(label, payload.integrity, issues);
}

function validateAppBackgroundServiceReleaseCapability(
  label: string,
  capability: AppBackgroundServiceReleaseCapability | undefined,
  platforms: readonly AppReleasePlatform[],
  issues: string[],
): void {
  if (!capability) {
    issues.push(`${label} metadata is required`);
    return;
  }
  if (capability.schema !== "butler.app-background-service-capability.v1") {
    issues.push(`${label} schema mismatch`);
  }
  if (capability.serviceCapable !== true) {
    issues.push(`${label} must be service capable`);
  }
  if (capability.gatewayProfile !== "electron") {
    issues.push(`${label} gateway profile must be electron`);
  }
  if (capability.serviceOwner !== "butler-agent") {
    issues.push(`${label} service owner must be butler-agent`);
  }
  if (capability.appGatewayOwner !== "background-agent-service") {
    issues.push(`${label} app gateway owner must be background-agent-service`);
  }
  if (capability.runtimePointerPath !== "$BUTLER_DATA/app/runtime/agent/current.json") {
    issues.push(`${label} runtime pointer path mismatch`);
  }
  for (const field of APP_BACKGROUND_SERVICE_RUNTIME_FIELDS) {
    if (!capability.requiredRuntimeFields.includes(field)) {
      issues.push(`${label} missing runtime field: ${field}`);
    }
  }
  for (const status of APP_AGENT_SERVICE_STATUSES) {
    if (!capability.serviceStatuses.includes(status)) {
      issues.push(`${label} missing service status: ${status}`);
    }
  }
  for (const status of APP_AGENT_UPDATE_STATUSES) {
    if (!capability.updateStatuses.includes(status)) {
      issues.push(`${label} missing update status: ${status}`);
    }
  }
  const expectedPlatforms = platforms.map(servicePlatformForReleasePlatform);
  for (const platform of expectedPlatforms) {
    const requirement = capability.installerRequirements.find(
      (item) => item.platform === platform,
    );
    if (!requirement) {
      issues.push(`${label} missing installer requirement for ${platform}`);
      continue;
    }
    const expectedPath = selectedInstallerV1Path(platform);
    if (requirement.selectedV1Path !== expectedPath) {
      issues.push(`${label} ${platform} selected installer path mismatch`);
    }
    const expectsService = false;
    if (requirement.installerRequired !== (expectsService ? "yes" : "no")) {
      issues.push(`${label} ${platform} installer requirement mismatch`);
    }
    if (requirement.registersUserService !== expectsService) {
      issues.push(`${label} ${platform} user service registration mismatch`);
    }
    for (const format of serviceInstallerPackageFormats(platform)) {
      if (!requirement.packageFormats.includes(format)) {
        issues.push(`${label} ${platform} missing package format: ${format}`);
      }
    }
  }
  if (capability.rawTextIncluded !== false) {
    issues.push(`${label} must not include raw text`);
  }
}

function validateAppServiceInstallerBundle(
  label: string,
  bundle: AppServiceInstallerBundleMetadata | undefined,
  platforms: readonly AppReleasePlatform[],
  version: string,
  issues: string[],
): void {
  if (!bundle) {
    issues.push(`${label} metadata is required`);
    return;
  }
  if (bundle.schema !== "butler.app-service-installer-bundle.v1") {
    issues.push(`${label} schema mismatch`);
  }
  if (bundle.product !== "butler-app") {
    issues.push(`${label} product must be butler-app`);
  }
  if (bundle.gatewayProfile !== "electron") {
    issues.push(`${label} gateway profile must be electron`);
  }
  if (bundle.resourcePath !== "bundled-agent/service-installer/installer-manifest.json") {
    issues.push(`${label} resource path mismatch`);
  }
  if (bundle.installerRootPath !== "bundled-agent/service-installer") {
    issues.push(`${label} installer root path mismatch`);
  }
  if (bundle.hostToolsRequiredForFirstLaunch.length > 0) {
    issues.push(`${label} must not require host first-launch tools`);
  }
  const expectedServicePlatforms = uniqueServicePlatforms(platforms);
  if (!sameComponentSet(bundle.servicePlatforms, expectedServicePlatforms)) {
    issues.push(`${label} service platform mismatch`);
  }
  const expectedArtifacts = uniqueReleasePlatformsByServicePlatform(platforms).flatMap((platform) =>
    serviceInstallerPackageArtifactsForPlatform(platform, version),
  );
  if (bundle.packageArtifacts.length !== expectedArtifacts.length) {
    issues.push(`${label} package artifact count mismatch`);
  }
  for (const expected of expectedArtifacts) {
    const actual = bundle.packageArtifacts.find((item) =>
      item.packageFormat === expected.packageFormat &&
      item.selectedV1Path === expected.selectedV1Path,
    );
    if (!actual) {
      issues.push(
        `${label} missing package artifact: ${expected.packageFormat}/${expected.selectedV1Path}`,
      );
      continue;
    }
    if (
      actual.serviceManager !== expected.serviceManager ||
      actual.serviceDefinitionTarget !== expected.serviceDefinitionTarget ||
      actual.renderContractPath !== expected.renderContractPath ||
      actual.launcherPath !== expected.launcherPath ||
      actual.postInstallPath !== expected.postInstallPath ||
      actual.publishedArtifactName !== expected.publishedArtifactName ||
      actual.publishedSha256Name !== expected.publishedSha256Name
    ) {
      issues.push(
        `${label} package artifact path mismatch: ${expected.packageFormat}/${expected.selectedV1Path}`,
      );
    }
  }
  if (bundle.rawTemplateIncluded !== false) {
    issues.push(`${label} must not include raw templates`);
  }
  if (bundle.rawTextIncluded !== false) {
    issues.push(`${label} must not include raw text`);
  }
}

function validateAppDesktopHelper(
  label: string,
  helper: AppDesktopHelperMetadata | undefined,
  platforms: readonly AppReleasePlatform[],
  issues: string[],
): void {
  if (!helper) {
    issues.push(`${label} metadata is required`);
    return;
  }
  if (helper.schema !== "butler.app-desktop-helper.v1") {
    issues.push(`${label} schema mismatch`);
  }
  if (helper.product !== "butler-app" || helper.owner !== "butler-app") {
    issues.push(`${label} owner must be butler-app`);
  }
  if (helper.helperMode !== "electron-main-tray") {
    issues.push(`${label} helper mode mismatch`);
  }
  const expectedDefaultPlatforms = persistentMenuBarHelperDefaultPlatforms(platforms);
  if (!sameComponentSet(helper.defaultEnabledPlatforms ?? [], expectedDefaultPlatforms)) {
    issues.push(`${label} default-enabled platform mismatch`);
  }
  if (!sameComponentSet(helper.survivesMainUiQuitPlatforms ?? [], expectedDefaultPlatforms)) {
    issues.push(`${label} persistent platform mismatch`);
  }
  if (helper.stopsAgentOnHelperQuit !== false) {
    issues.push(`${label} helper quit must not stop Agent`);
  }
  const expectedPlatforms = uniqueServicePlatforms(platforms);
  if (!sameComponentSet(helper.platforms, expectedPlatforms)) {
    issues.push(`${label} platform mismatch`);
  }
  if (helper.rawTextIncluded !== false) {
    issues.push(`${label} must not include raw text`);
  }
}

function validateProtocolCompatibility(
  label: string,
  compatibility: AppReleaseProtocolCompatibility | undefined,
  issues: string[],
): void {
  if (!compatibility) {
    issues.push(`${label} protocol compatibility is required`);
    return;
  }
  if (
    compatibility.protocol !== "butler.app.v1" ||
    compatibility.minimumAppProtocol !== "butler.app.v1" ||
    compatibility.maximumAppProtocol !== "butler.app.v1"
  ) {
    issues.push(`${label} protocol compatibility must be butler.app.v1`);
  }
}

function validateArtifactIntegrity(
  label: string,
  integrity: AppReleaseIntegrityMetadata | undefined,
  issues: string[],
): void {
  if (!integrity) {
    issues.push(`${label} integrity metadata is required`);
    return;
  }
  if (integrity.digestAlgorithm !== "sha256") {
    issues.push(`${label} digest algorithm must be sha256`);
  }
  if (integrity.signature !== null && !integrity.signature.trim()) {
    issues.push(`${label} signature metadata must be null or non-empty`);
  }
}

function validateAppOperationMetadata(
  label: string,
  value: Pick<
    AppReleaseComponent | AppReleaseArtifact,
    | "updatePolicy"
    | "restartPolicy"
    | "updaterOwner"
    | "payloadFormat"
    | "stagingPolicy"
    | "activationPolicy"
    | "rollbackPolicy"
  >,
  issues: string[],
): void {
  if (value.updatePolicy !== "app-user-action")
    issues.push(`${label} update policy must be app-user-action`);
  if (value.restartPolicy !== "restart-app")
    issues.push(`${label} restart policy must be restart-app`);
  if (value.updaterOwner !== "butler-app")
    issues.push(`${label} updater owner must be butler-app`);
  if (value.payloadFormat !== "platform-app-package")
    issues.push(`${label} payload format must be platform-app-package`);
  if (value.stagingPolicy !== "platform-updater-cache")
    issues.push(`${label} staging policy must be platform-updater-cache`);
  if (
    value.activationPolicy !== "platform-app-update-then-versioned-app-runtime"
  ) {
    issues.push(
      `${label} activation policy must be platform-app-update-then-versioned-app-runtime`,
    );
  }
  if (value.rollbackPolicy !== "preserve-previous-app-managed-runtime") {
    issues.push(
      `${label} rollback policy must be preserve-previous-app-managed-runtime`,
    );
  }
}

function sameComponentSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}
