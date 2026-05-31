import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { butlerAgentResourcesPath } from "../../runtime/paths.ts";

export const RELEASE_COMPONENT_IDS = ["service"] as const;
export type ReleaseComponentId = (typeof RELEASE_COMPONENT_IDS)[number];
export type ReleaseRestartPolicy = "restart-service";
export type ReleaseUpdatePolicy = "explicit";

export interface ReleaseComponent {
  id: ReleaseComponentId;
  name: string;
  version: string;
  versionSource: string;
  bundledComponents: ReleaseComponentId[];
  requiredFiles: string[];
  privateDataPatterns: string[];
  updatePolicy: ReleaseUpdatePolicy;
  restartPolicy: ReleaseRestartPolicy;
}

export interface ReleaseArtifact {
  component: ReleaseComponentId;
  version: string;
  channel: "stable";
  platform: "all";
  artifactName: string;
  downloadUrl: string | null;
  sha256: string | null;
  signature: string | null;
  bundledComponents: ReleaseComponentId[];
  compatibleProtocol: null;
  updatePolicy: ReleaseUpdatePolicy;
  restartPolicy: ReleaseRestartPolicy;
}

export interface ReleaseManifest {
  name: string;
  version: string;
  bin: Record<string, string>;
  managedRuntimeVersion: string;
  requiredFiles: string[];
  privateDataPatterns: string[];
  components: ReleaseComponent[];
  artifacts: ReleaseArtifact[];
}

export interface ComponentVersions {
  service: string;
}

const SERVICE_RELEASE_FORBIDDEN_APP_PATH_PREFIXES = [
  "packages/butler-app/",
] as const;

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
  const serviceFiles = [
    "package.json",
    "bun.lock",
    "bin/butler.js",
    "install.sh",
    "butler.config.template.json",
    "LICENSE",
    "packages/butler-agent/src/agent",
    "packages/butler-agent/src/gateways",
    "packages/butler-agent/src/integrations",
    "packages/butler-agent/src/interfaces",
    "packages/butler-agent/src/operations",
    "packages/butler-agent/src/personalization",
    "packages/butler-agent/src/runtime",
    "packages/butler-agent/src/test-support",
    "packages/butler-agent/scripts",
    "packages/butler-agent/resources",
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
    name: "Butler Service",
    version: versions.service,
    versionSource: "VERSION",
    bundledComponents: ["service"],
    requiredFiles: serviceFiles,
    privateDataPatterns,
    updatePolicy: "explicit",
    restartPolicy: "restart-service",
  }];
  return {
    name: String(pkg.name ?? ""),
    version: versions.service,
    bin: pkg.bin && typeof pkg.bin === "object" ? pkg.bin : {},
    managedRuntimeVersion: existsSync(runtimeVersionPath)
      ? readText(runtimeVersionPath)
      : "unknown",
    requiredFiles: serviceFiles,
    privateDataPatterns,
    components,
    artifacts: components.map((component) => ({
      component: component.id,
      version: component.version,
      channel: "stable",
      platform: "all",
      artifactName: artifactName(component.id, component.version),
      downloadUrl: null,
      sha256: null,
      signature: null,
      bundledComponents: component.bundledComponents,
      compatibleProtocol: null,
      updatePolicy: component.updatePolicy,
      restartPolicy: component.restartPolicy,
    })),
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
  validateRequiredFiles(root, manifest.requiredFiles, issues);
  validateNoAppInternals(manifest.requiredFiles, issues);
  validatePrivatePatterns(root, manifest.privateDataPatterns, issues);
  validateComponents(root, manifest, versions, issues);
  validateArtifacts(manifest, issues);
  return issues;
}

function artifactName(component: ReleaseComponentId, version: string): string {
  return `butler-${component}-${version}-all.tar.gz`;
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
    if (component.version !== versions.service) {
      issues.push(`component ${component.id} version source mismatch`);
    }
    validateRequiredFiles(root, component.requiredFiles, issues);
    validateNoAppInternals(component.requiredFiles, issues);
    validatePrivatePatterns(root, component.privateDataPatterns, issues);
  }
  if (!components.has("service")) issues.push("missing release component: service");
  const service = components.get("service");
  if (service && !sameComponentSet(service.bundledComponents, ["service"])) {
    issues.push("service component must not bundle app");
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
      issues.push(`service release required file must not include app internals: ${file}`);
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
    const component = manifest.components.find((item) => item.id === artifact.component);
    if (!component) continue;
    if (artifact.version !== component.version) {
      issues.push(`artifact ${artifact.component} version mismatch`);
    }
    if (!sameComponentSet(artifact.bundledComponents, component.bundledComponents)) {
      issues.push(`artifact ${artifact.component} bundled component mismatch`);
    }
    if (!sameComponentSet(artifact.bundledComponents, ["service"])) {
      issues.push("service artifact must not bundle app");
    }
    if (!artifact.artifactName.trim()) {
      issues.push(`artifact ${artifact.component} must have an artifact name`);
    }
  }
  if (!artifactComponents.has("service")) {
    issues.push("missing release artifact: service");
  }
}

function sameComponentSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}
