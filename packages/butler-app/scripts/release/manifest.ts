import { existsSync, readFileSync } from "fs";
import { join } from "path";

export const APP_RELEASE_COMPONENT_IDS = ["app"] as const;
export const APP_RELEASE_PLATFORMS = ["darwin-arm64", "linux-x64"] as const;
export type AppReleaseComponentId = (typeof APP_RELEASE_COMPONENT_IDS)[number];
export type AppReleasePlatform = (typeof APP_RELEASE_PLATFORMS)[number];
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

export interface AppReleaseComponent {
  id: AppReleaseComponentId;
  product: AppReleaseProduct;
  name: string;
  version: string;
  versionSource: string;
  gatewayProfile: AppReleaseGatewayProfile;
  bundledAgentVersion: string;
  bundledAgentPayload: AppBundledAgentPayload;
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
  protocolCompatibility: AppReleaseProtocolCompatibility;
  integrity: AppReleaseIntegrityMetadata;
  updatePolicy: AppReleaseUpdatePolicy;
  restartPolicy: AppReleaseRestartPolicy;
  updaterOwner: AppReleaseUpdaterOwner;
  payloadFormat: AppReleasePayloadFormat;
  stagingPolicy: AppReleaseStagingPolicy;
  activationPolicy: AppReleaseActivationPolicy;
  rollbackPolicy: AppReleaseRollbackPolicy;
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
  updaterOwner: AppReleaseUpdaterOwner;
  components: AppReleaseComponent[];
  artifacts: AppReleaseArtifact[];
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

export function createAppReleaseManifest(root: string): AppReleaseManifest {
  const versions = readAppComponentVersions(root);
  const bundledAgentPayload = createBundledAgentPayloadMetadata(versions.bundledAgent);
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
    updaterOwner: "butler-app",
    components,
    artifacts: components.flatMap((component) =>
      APP_RELEASE_PLATFORMS.map((platform) => ({
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
        bundledAgentPayload,
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
      })),
    ),
  };
}

function createBundledAgentPayloadMetadata(
  version: string,
  digest: string | null = null,
): AppBundledAgentPayload {
  const artifactName = `butler-agent-${version}-all.tar.gz`;
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

export function validateAppReleaseManifest(
  root: string,
  manifest = createAppReleaseManifest(root),
): string[] {
  const issues: string[] = [];
  const versions = readAppComponentVersions(root);
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
  if (manifest.updaterOwner !== "butler-app")
    issues.push("app release updater owner must be butler-app");
  if (!manifest.version || manifest.version !== versions.app) {
    issues.push("app package version mismatch");
  }
  validateComponents(root, manifest, versions, issues);
  validateArtifacts(manifest, issues);
  return issues;
}

function artifactName(
  _component: AppReleaseComponentId,
  version: string,
  platform: AppReleasePlatform,
): string {
  const extension = platform === "darwin-arm64" ? "zip" : "tar.gz";
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
    if (!APP_RELEASE_PLATFORMS.includes(artifact.platform)) {
      issues.push(`unknown app release artifact platform: ${artifact.platform}`);
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
  }
  for (const id of APP_RELEASE_COMPONENT_IDS) {
    if (!artifactComponents.has(id)) {
      issues.push(`missing app release artifact: ${id}`);
    }
    const platforms = artifactPlatforms.get(id) ?? new Set();
    for (const platform of APP_RELEASE_PLATFORMS) {
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
  if (payload.artifactName !== `butler-agent-${expectedVersion}-all.tar.gz`) {
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
