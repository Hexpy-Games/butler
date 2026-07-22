import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { butlerAgentResourcesPath } from "../../runtime/paths.ts";

export const RELEASE_COMPONENT_IDS = ["service"] as const;
export type ReleaseComponentId = (typeof RELEASE_COMPONENT_IDS)[number];
export type ReleaseRestartPolicy = "restart-service";
export type ReleaseUpdatePolicy = "explicit";
export type ReleaseProduct = "butler-agent";
export type ReleaseCanonicalComponent = "agent";
export type ReleaseProfile = "agent-standalone";
export type ReleaseUpdaterOwner = "butler-agent";
export type ReleasePayloadFormat = "agent-archive";
export type ReleaseStagingPolicy = "butler-data-updates";
export type ReleaseActivationPolicy = "versioned-standalone-runtime";
export type ReleaseRollbackPolicy = "preserve-previous-standalone-runtime";
export type ReleaseOperatorCommand = "init" | "start" | "status" | "stop" | "doctor";
export type ReleaseOperatorCommandMap = Record<ReleaseOperatorCommand, string[]>;

export interface ReleaseDesktopCompanionPolicy {
  defaultMode: "headless";
  autoRegister: false;
  optInCommand: string | null;
}

export interface ReleaseProtocolCompatibility {
  protocol: "butler.agent.v1";
  minimumAgentProtocol: "butler.agent.v1";
  maximumAgentProtocol: "butler.agent.v1";
}

export interface ReleaseIntegrityMetadata {
  digestAlgorithm: "sha256";
  digest: string | null;
  signature: string | null;
}

export interface AgentArtifactLayout {
  executable: string;
  runtimeResolver: string;
  runtimePayload: string;
  configTemplates: string[];
  serviceTemplates: string[];
  manifestPath: string;
}
export const SERVICE_CLI_LAUNCHER_PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "windows-x64",
] as const;
export const SERVICE_APP_WEB_CLIENT_DIST =
  "packages/butler-agent/resources/app-client/dist";
export type ServiceCliLauncherPlatform =
  (typeof SERVICE_CLI_LAUNCHER_PLATFORMS)[number];

export interface ServiceCliLauncher {
  platform: ServiceCliLauncherPlatform;
  path: string;
  buildTarget: string;
}

export interface ReleaseComponent {
  id: ReleaseComponentId;
  product: ReleaseProduct;
  canonicalComponent: ReleaseCanonicalComponent;
  legacyAliases: ReleaseComponentId[];
  profile: ReleaseProfile;
  name: string;
  version: string;
  versionSource: string;
  protocolCompatibility: ReleaseProtocolCompatibility;
  bundledComponents: ReleaseComponentId[];
  requiredFiles: string[];
  privateDataPatterns: string[];
  updatePolicy: ReleaseUpdatePolicy;
  restartPolicy: ReleaseRestartPolicy;
  updaterOwner: ReleaseUpdaterOwner;
  payloadFormat: ReleasePayloadFormat;
  stagingPolicy: ReleaseStagingPolicy;
  activationPolicy: ReleaseActivationPolicy;
  rollbackPolicy: ReleaseRollbackPolicy;
  artifactLayout: AgentArtifactLayout;
  operatorCommands: ReleaseOperatorCommand[];
  operatorCommandMap: ReleaseOperatorCommandMap;
  desktopCompanion: ReleaseDesktopCompanionPolicy;
}

export interface ReleaseArtifact {
  product: ReleaseProduct;
  component: ReleaseComponentId;
  canonicalComponent: ReleaseCanonicalComponent;
  profile: ReleaseProfile;
  version: string;
  channel: "stable";
  platform: "all";
  artifactName: string;
  downloadUrl: string | null;
  sha256: string | null;
  signature: string | null;
  bundledComponents: ReleaseComponentId[];
  compatibleProtocol: null;
  protocolCompatibility: ReleaseProtocolCompatibility;
  integrity: ReleaseIntegrityMetadata;
  updatePolicy: ReleaseUpdatePolicy;
  restartPolicy: ReleaseRestartPolicy;
  updaterOwner: ReleaseUpdaterOwner;
  payloadFormat: ReleasePayloadFormat;
  stagingPolicy: ReleaseStagingPolicy;
  activationPolicy: ReleaseActivationPolicy;
  rollbackPolicy: ReleaseRollbackPolicy;
}

export interface ReleaseManifest {
  name: string;
  product: ReleaseProduct;
  publicProductGroups: ReleaseProduct[];
  profile: ReleaseProfile;
  canonicalComponent: ReleaseCanonicalComponent;
  legacyComponentAliases: ReleaseComponentId[];
  version: string;
  protocolCompatibility: ReleaseProtocolCompatibility;
  bin: Record<string, string>;
  managedRuntimeVersion: string;
  appWebClientDist: string;
  cliLaunchers: ServiceCliLauncher[];
  requiredFiles: string[];
  privateDataPatterns: string[];
  components: ReleaseComponent[];
  artifacts: ReleaseArtifact[];
  agentArtifactLayout: AgentArtifactLayout;
  operatorCommands: ReleaseOperatorCommand[];
  operatorCommandMap: ReleaseOperatorCommandMap;
  desktopCompanion: ReleaseDesktopCompanionPolicy;
}

export interface ComponentVersions {
  service: string;
}

const SERVICE_RELEASE_FORBIDDEN_APP_PATH_PREFIXES = [
  "packages/butler-app/",
] as const;
const AGENT_ARTIFACT_LAYOUT: AgentArtifactLayout = {
  executable: "bin/butler.js",
  runtimeResolver: "packages/butler-agent/scripts/start-butler.sh",
  runtimePayload: "packages/butler-agent",
  configTemplates: ["butler.config.template.json"],
  serviceTemplates: [
    "deploy/agent/templates/launchd.plist.template",
    "deploy/agent/templates/systemd.service.template",
  ],
  manifestPath: "agent-release-manifest.json",
};
const AGENT_OPERATOR_COMMANDS: ReleaseOperatorCommand[] = [
  "init",
  "start",
  "status",
  "stop",
  "doctor",
];
const AGENT_OPERATOR_COMMAND_MAP: ReleaseOperatorCommandMap = {
  init: ["butler", "install"],
  start: ["butler", "start"],
  status: ["butler", "status"],
  stop: ["butler", "stop"],
  doctor: ["butler", "doctor"],
};
const AGENT_DESKTOP_COMPANION_POLICY: ReleaseDesktopCompanionPolicy = {
  defaultMode: "headless",
  autoRegister: false,
  optInCommand: null,
};

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path: string): string {
  return readFileSync(path, "utf8").trim();
}

export function readComponentVersions(root: string): ComponentVersions {
  const pkg = readJson(join(root, "package.json"));
  const serviceVersionPath = join(root, "VERSION");
  return {
    service: existsSync(serviceVersionPath)
      ? readText(serviceVersionPath)
      : String(pkg.version ?? ""),
  };
}

export function createReleaseManifest(root: string): ReleaseManifest {
  const pkg = readJson(join(root, "package.json"));
  const runtimeVersionPath = butlerAgentResourcesPath(root, "runtime", "bun-version");
  const versions = readComponentVersions(root);
  const protocolCompatibility: ReleaseProtocolCompatibility = {
    protocol: "butler.agent.v1",
    minimumAgentProtocol: "butler.agent.v1",
    maximumAgentProtocol: "butler.agent.v1",
  };
  const serviceFiles = [
    "package.json",
    "bun.lock",
    "bin/butler.js",
    "install.sh",
    "butler.config.template.json",
    "LICENSE",
    "deploy/agent",
    "deploy/agent/templates",
    "packages/butler-agent/src",
    "packages/butler-agent/scripts",
    "packages/butler-agent/resources",
    "packages/butler-progress-projection",
    "packages/project-ledger",
    "VERSION",
    "README.md",
  ];
  const privateDataPatterns = [
    "data/",
    ".butler/",
    "memory/hot/",
    "transcripts/",
    "tasks/",
  ];
  const components: ReleaseComponent[] = [{
    id: "service",
    product: "butler-agent",
    canonicalComponent: "agent",
    legacyAliases: ["service"],
    profile: "agent-standalone",
    name: "Butler Agent",
    version: versions.service,
    versionSource: "VERSION",
    protocolCompatibility,
    bundledComponents: ["service"],
    requiredFiles: serviceFiles,
    privateDataPatterns,
    updatePolicy: "explicit",
    restartPolicy: "restart-service",
    updaterOwner: "butler-agent",
    payloadFormat: "agent-archive",
    stagingPolicy: "butler-data-updates",
    activationPolicy: "versioned-standalone-runtime",
    rollbackPolicy: "preserve-previous-standalone-runtime",
    artifactLayout: AGENT_ARTIFACT_LAYOUT,
    operatorCommands: AGENT_OPERATOR_COMMANDS,
    operatorCommandMap: AGENT_OPERATOR_COMMAND_MAP,
    desktopCompanion: AGENT_DESKTOP_COMPANION_POLICY,
  }];
  return {
    name: String(pkg.name ?? ""),
    product: "butler-agent",
    publicProductGroups: ["butler-agent"],
    profile: "agent-standalone",
    canonicalComponent: "agent",
    legacyComponentAliases: ["service"],
    version: versions.service,
    protocolCompatibility,
    bin: pkg.bin && typeof pkg.bin === "object" ? pkg.bin : {},
    managedRuntimeVersion: existsSync(runtimeVersionPath)
      ? readText(runtimeVersionPath)
      : "unknown",
    appWebClientDist: SERVICE_APP_WEB_CLIENT_DIST,
    cliLaunchers: SERVICE_CLI_LAUNCHER_PLATFORMS.map((platform) => ({
      platform,
      path: serviceCliLauncherRelativePath(platform),
      buildTarget: serviceCliLauncherBuildTarget(platform),
    })),
    requiredFiles: serviceFiles,
    privateDataPatterns,
    components,
    artifacts: components.map((component) => ({
      product: "butler-agent",
      component: component.id,
      canonicalComponent: "agent",
      profile: "agent-standalone",
      version: component.version,
      channel: "stable",
      platform: "all",
      artifactName: artifactName(component.id, component.version),
      downloadUrl: null,
      sha256: null,
      signature: null,
      bundledComponents: component.bundledComponents,
      compatibleProtocol: null,
      protocolCompatibility,
      integrity: {
        digestAlgorithm: "sha256",
        digest: null,
        signature: null,
      },
      updatePolicy: component.updatePolicy,
      restartPolicy: component.restartPolicy,
      updaterOwner: "butler-agent",
      payloadFormat: "agent-archive",
      stagingPolicy: "butler-data-updates",
      activationPolicy: "versioned-standalone-runtime",
      rollbackPolicy: "preserve-previous-standalone-runtime",
    })),
    agentArtifactLayout: AGENT_ARTIFACT_LAYOUT,
    operatorCommands: AGENT_OPERATOR_COMMANDS,
    operatorCommandMap: AGENT_OPERATOR_COMMAND_MAP,
    desktopCompanion: AGENT_DESKTOP_COMPANION_POLICY,
  };
}

export function validateReleaseManifest(
  root: string,
  manifest = createReleaseManifest(root),
): string[] {
  const issues: string[] = [];
  const pkg = readJson(join(root, "package.json"));
  const versions = readComponentVersions(root);
  if (manifest.name !== "butler") issues.push("package name must be butler");
  if (manifest.product !== "butler-agent")
    issues.push("release product must be butler-agent");
  if (!sameComponentSet(manifest.publicProductGroups ?? [], ["butler-agent"])) {
    issues.push("release public product groups must contain only butler-agent");
  }
  if (manifest.profile !== "agent-standalone")
    issues.push("release profile must be agent-standalone");
  if (manifest.canonicalComponent !== "agent")
    issues.push("release canonical component must be agent");
  if (!sameComponentSet(manifest.legacyComponentAliases ?? [], ["service"])) {
    issues.push("release legacy aliases must contain service");
  }
  validateProtocolCompatibility("release manifest", manifest.protocolCompatibility, issues);
  if (
    !manifest.version ||
    manifest.version !== versions.service ||
    String(pkg.version ?? "") !== versions.service
  ) {
    issues.push("package/VERSION mismatch");
  }
  if (manifest.bin.butler !== "./bin/butler.js") {
    issues.push("package bin.butler must point to ./bin/butler.js");
  }
  if (manifest.appWebClientDist !== SERVICE_APP_WEB_CLIENT_DIST) {
    issues.push("service app web client dist path mismatch");
  }
  validateRequiredFiles(root, manifest.requiredFiles, issues);
  validateNoAppInternals(manifest.requiredFiles, issues);
  validatePrivatePatterns(root, manifest.privateDataPatterns, issues);
  validateCliLaunchers(manifest.cliLaunchers, issues);
  validateAgentArtifactLayout(root, "release", manifest.agentArtifactLayout, issues);
  validateOperatorCommands("release", manifest.operatorCommands, issues);
  validateOperatorCommandMap("release", manifest.operatorCommandMap, issues);
  validateDesktopCompanionPolicy("release", manifest.desktopCompanion, issues);
  validateComponents(root, manifest, versions, issues);
  validateArtifacts(manifest, issues);
  return issues;
}

function validateDesktopCompanionPolicy(
  label: string,
  policy: ReleaseDesktopCompanionPolicy | undefined,
  issues: string[],
): void {
  if (!policy) {
    issues.push(`${label} desktop companion policy is required`);
    return;
  }
  if (policy.defaultMode !== "headless") {
    issues.push(`${label} desktop companion default must be headless`);
  }
  if (policy.autoRegister !== false) {
    issues.push(`${label} desktop companion must not auto-register`);
  }
  if (policy.optInCommand !== null && typeof policy.optInCommand !== "string") {
    issues.push(`${label} desktop companion opt-in command must be null or string`);
  }
}

export function serviceCliLauncherRelativePath(
  platform: ServiceCliLauncherPlatform,
): string {
  return `packages/butler-agent/resources/cli/${platform}/butler${
    platform === "windows-x64" ? ".exe" : ""
  }`;
}

export function serviceCliLauncherBuildTarget(
  platform: ServiceCliLauncherPlatform,
): string {
  return `bun-${platform}`;
}

function artifactName(component: ReleaseComponentId, version: string): string {
  const product = component === "service" ? "agent" : component;
  return `butler-${product}-${version}-all.tar.gz`;
}

function validateRequiredFiles(
  root: string,
  files: string[],
  issues: string[],
): void {
  for (const file of files) {
    if (!existsSync(join(root, file))) {
      issues.push(`missing required release file: ${file}`);
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
      issues.push(`private data path must not be packaged from repo root: ${pattern}`);
    }
  }
}

function validateComponents(
  root: string,
  manifest: ReleaseManifest,
  versions: ComponentVersions,
  issues: string[],
): void {
  const components = new Map<ReleaseComponentId, ReleaseComponent>();
  for (const component of manifest.components) {
    if (!RELEASE_COMPONENT_IDS.includes(component.id)) {
      issues.push(`unknown release component: ${component.id}`);
      continue;
    }
    if (components.has(component.id)) {
      issues.push(`duplicate release component: ${component.id}`);
    }
    components.set(component.id, component);
    if (component.product !== "butler-agent") {
      issues.push(`component ${component.id} product must be butler-agent`);
    }
    if (component.canonicalComponent !== "agent") {
      issues.push(`component ${component.id} canonical component must be agent`);
    }
    if (!sameComponentSet(component.legacyAliases, ["service"])) {
      issues.push(`component ${component.id} legacy aliases must contain service`);
    }
    if (component.profile !== "agent-standalone") {
      issues.push(`component ${component.id} profile must be agent-standalone`);
    }
    if (component.version !== versions.service) {
      issues.push(`component ${component.id} version source mismatch`);
    }
    validateProtocolCompatibility(
      `component ${component.id}`,
      component.protocolCompatibility,
      issues,
    );
    validateReleaseOperationMetadata(`component ${component.id}`, component, issues);
    validateAgentArtifactLayout(root, `component ${component.id}`, component.artifactLayout, issues);
    validateOperatorCommands(`component ${component.id}`, component.operatorCommands, issues);
    validateOperatorCommandMap(`component ${component.id}`, component.operatorCommandMap, issues);
    validateDesktopCompanionPolicy(
      `component ${component.id}`,
      component.desktopCompanion,
      issues,
    );
    validateRequiredFiles(root, component.requiredFiles, issues);
    validateNoAppInternals(component.requiredFiles, issues);
    validatePrivatePatterns(root, component.privateDataPatterns, issues);
  }
  if (!components.has("service")) issues.push("missing release component: service");
  const service = components.get("service");
  if (service && !sameComponentSet(service.bundledComponents, ["service"])) {
    issues.push("Butler Agent component must not bundle app");
  }
}

function validateAgentArtifactLayout(
  root: string,
  label: string,
  layout: AgentArtifactLayout | undefined,
  issues: string[],
): void {
  if (!layout) {
    issues.push(`${label} artifact layout is required`);
    return;
  }
  if (layout.executable !== "bin/butler.js") {
    issues.push(`${label} artifact layout executable must be bin/butler.js`);
  }
  if (layout.runtimeResolver !== "packages/butler-agent/scripts/start-butler.sh") {
    issues.push(`${label} artifact layout runtime resolver mismatch`);
  }
  if (layout.runtimePayload !== "packages/butler-agent") {
    issues.push(`${label} artifact layout runtime payload mismatch`);
  }
  if (!sameComponentSet(layout.configTemplates, ["butler.config.template.json"])) {
    issues.push(`${label} artifact layout must include config templates`);
  }
  if (
    !sameComponentSet(layout.serviceTemplates, [
      "deploy/agent/templates/launchd.plist.template",
      "deploy/agent/templates/systemd.service.template",
    ])
  ) {
    issues.push(`${label} artifact layout must include service templates`);
  }
  if (layout.manifestPath !== "agent-release-manifest.json") {
    issues.push(`${label} artifact layout manifest path mismatch`);
  }
  for (const file of [
    layout.executable,
    layout.runtimeResolver,
    layout.runtimePayload,
    ...layout.configTemplates,
    ...layout.serviceTemplates,
  ]) {
    if (!existsSync(join(root, file))) {
      issues.push(`${label} artifact layout file is missing: ${file}`);
    }
  }
}

function validateOperatorCommands(
  label: string,
  commands: ReleaseOperatorCommand[] | undefined,
  issues: string[],
): void {
  if (!sameComponentSet(commands ?? [], AGENT_OPERATOR_COMMANDS)) {
    issues.push(`${label} operator commands must include init/start/status/stop/doctor`);
  }
}

function validateOperatorCommandMap(
  label: string,
  commandMap: ReleaseOperatorCommandMap | undefined,
  issues: string[],
): void {
  if (!commandMap) {
    issues.push(`${label} operator command map is required`);
    return;
  }
  for (const command of AGENT_OPERATOR_COMMANDS) {
    const expected = AGENT_OPERATOR_COMMAND_MAP[command];
    const actual = commandMap[command];
    if (!Array.isArray(actual) || actual.join(" ") !== expected.join(" ")) {
      issues.push(`${label} operator command ${command} must map to ${expected.join(" ")}`);
    }
  }
}

function validateNoAppInternals(
  files: string[],
  issues: string[],
): void {
  for (const file of files) {
    if (
      SERVICE_RELEASE_FORBIDDEN_APP_PATH_PREFIXES.some(
        (prefix) => file === prefix || file.startsWith(prefix),
      )
    ) {
      issues.push(`Butler Agent release required file must not include app internals: ${file}`);
    }
  }
}

function validateCliLaunchers(
  launchers: ServiceCliLauncher[],
  issues: string[],
): void {
  const seen = new Set<ServiceCliLauncherPlatform>();
  for (const launcher of launchers) {
    if (!SERVICE_CLI_LAUNCHER_PLATFORMS.includes(launcher.platform)) {
      issues.push(`unknown service CLI launcher platform: ${launcher.platform}`);
      continue;
    }
    if (seen.has(launcher.platform)) {
      issues.push(`duplicate service CLI launcher platform: ${launcher.platform}`);
    }
    seen.add(launcher.platform);
    const expectedPath = serviceCliLauncherRelativePath(launcher.platform);
    if (launcher.path !== expectedPath) {
      issues.push(`service CLI launcher path mismatch for ${launcher.platform}`);
    }
    const expectedTarget = serviceCliLauncherBuildTarget(launcher.platform);
    if (launcher.buildTarget !== expectedTarget) {
      issues.push(`service CLI launcher build target mismatch for ${launcher.platform}`);
    }
  }
  for (const platform of SERVICE_CLI_LAUNCHER_PLATFORMS) {
    if (!seen.has(platform)) {
      issues.push(`missing service CLI launcher platform: ${platform}`);
    }
  }
}

function validateArtifacts(
  manifest: ReleaseManifest,
  issues: string[],
): void {
  const artifactComponents = new Set<ReleaseComponentId>();
  for (const artifact of manifest.artifacts) {
    if (!RELEASE_COMPONENT_IDS.includes(artifact.component)) {
      issues.push(`unknown release artifact component: ${artifact.component}`);
      continue;
    }
    artifactComponents.add(artifact.component);
    if (artifact.product !== "butler-agent") {
      issues.push(`artifact ${artifact.component} product must be butler-agent`);
    }
    if (artifact.canonicalComponent !== "agent") {
      issues.push(`artifact ${artifact.component} canonical component must be agent`);
    }
    if (artifact.profile !== "agent-standalone") {
      issues.push(`artifact ${artifact.component} profile must be agent-standalone`);
    }
    const component = manifest.components.find((item) => item.id === artifact.component);
    if (!component) continue;
    if (artifact.version !== component.version) {
      issues.push(`artifact ${artifact.component} version mismatch`);
    }
    validateProtocolCompatibility(
      `artifact ${artifact.component}`,
      artifact.protocolCompatibility,
      issues,
    );
    validateArtifactIntegrity(`artifact ${artifact.component}`, artifact.integrity, issues);
    validateReleaseOperationMetadata(`artifact ${artifact.component}`, artifact, issues);
    if (!sameComponentSet(artifact.bundledComponents, component.bundledComponents)) {
      issues.push(`artifact ${artifact.component} bundled component mismatch`);
    }
    if (!sameComponentSet(artifact.bundledComponents, ["service"])) {
      issues.push("Butler Agent artifact must not bundle app");
    }
    if (!artifact.artifactName.trim()) {
      issues.push(`artifact ${artifact.component} must have an artifact name`);
    }
  }
  if (!artifactComponents.has("service")) {
    issues.push("missing release artifact: service");
  }
}

function validateProtocolCompatibility(
  label: string,
  compatibility: ReleaseProtocolCompatibility | undefined,
  issues: string[],
): void {
  if (!compatibility) {
    issues.push(`${label} protocol compatibility is required`);
    return;
  }
  if (
    compatibility.protocol !== "butler.agent.v1" ||
    compatibility.minimumAgentProtocol !== "butler.agent.v1" ||
    compatibility.maximumAgentProtocol !== "butler.agent.v1"
  ) {
    issues.push(`${label} protocol compatibility must be butler.agent.v1`);
  }
}

function validateArtifactIntegrity(
  label: string,
  integrity: ReleaseIntegrityMetadata | undefined,
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

function validateReleaseOperationMetadata(
  label: string,
  value: Pick<
    ReleaseComponent | ReleaseArtifact,
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
  if (value.updatePolicy !== "explicit")
    issues.push(`${label} update policy must be explicit`);
  if (value.restartPolicy !== "restart-service")
    issues.push(`${label} restart policy must be restart-service`);
  if (value.updaterOwner !== "butler-agent")
    issues.push(`${label} updater owner must be butler-agent`);
  if (value.payloadFormat !== "agent-archive")
    issues.push(`${label} payload format must be agent-archive`);
  if (value.stagingPolicy !== "butler-data-updates")
    issues.push(`${label} staging policy must be butler-data-updates`);
  if (value.activationPolicy !== "versioned-standalone-runtime") {
    issues.push(
      `${label} activation policy must be versioned-standalone-runtime`,
    );
  }
  if (value.rollbackPolicy !== "preserve-previous-standalone-runtime") {
    issues.push(
      `${label} rollback policy must be preserve-previous-standalone-runtime`,
    );
  }
}

function sameComponentSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}
