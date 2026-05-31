import { existsSync, readFileSync } from "fs";
import { join } from "path";

export const APP_RELEASE_COMPONENT_IDS = ["app"] as const;
export type AppReleaseComponentId = (typeof APP_RELEASE_COMPONENT_IDS)[number];
export type AppReleaseRestartPolicy = "restart-app";
export type AppReleaseUpdatePolicy = "app-user-action";

export interface AppReleaseComponent {
  id: AppReleaseComponentId;
  name: string;
  version: string;
  versionSource: string;
  bundledComponents: AppReleaseComponentId[];
  requiredFiles: string[];
  privateDataPatterns: string[];
  updatePolicy: AppReleaseUpdatePolicy;
  restartPolicy: AppReleaseRestartPolicy;
}

export interface AppReleaseArtifact {
  component: AppReleaseComponentId;
  version: string;
  channel: "stable";
  platform: "darwin-arm64";
  artifactName: string;
  downloadUrl: string | null;
  sha256: string | null;
  signature: string | null;
  bundledComponents: AppReleaseComponentId[];
  compatibleProtocol: "butler.app.v1";
  updatePolicy: AppReleaseUpdatePolicy;
  restartPolicy: AppReleaseRestartPolicy;
}

export interface AppReleaseManifest {
  name: "butler-app";
  protocol: "butler.app.v1";
  version: string;
  components: AppReleaseComponent[];
  artifacts: AppReleaseArtifact[];
}

export interface AppComponentVersions {
  app: string;
}

const APP_RELEASE_FORBIDDEN_SERVICE_PATH_PREFIXES = [
  "bin/butler.js",
  "packages/butler-agent/",
] as const;

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readAppComponentVersions(root: string): AppComponentVersions {
  const electronPkg = readJson(
    join(root, "packages", "butler-app", "client", "electron", "package.json"),
  );
  return {
    app: String(electronPkg.version ?? ""),
  };
}

export function createAppReleaseManifest(root: string): AppReleaseManifest {
  const versions = readAppComponentVersions(root);
  const appFiles = [
    "packages/butler-app/README.md",
    "packages/butler-app/client/README.md",
    "packages/butler-app/client/electron/package.json",
    "packages/butler-app/client/electron/main.mjs",
    "packages/butler-app/client/electron/preload.cjs",
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
      name: "Butler App",
      version: versions.app,
      versionSource: "packages/butler-app/client/electron/package.json",
      bundledComponents: ["app"],
      requiredFiles: appFiles,
      privateDataPatterns: [],
      updatePolicy: "app-user-action",
      restartPolicy: "restart-app",
    },
  ];
  return {
    name: "butler-app",
    protocol: "butler.app.v1",
    version: versions.app,
    components,
    artifacts: components.map((component) => ({
      component: component.id,
      version: component.version,
      channel: "stable",
      platform: "darwin-arm64",
      artifactName: artifactName(component.id, component.version),
      downloadUrl: null,
      sha256: null,
      signature: null,
      bundledComponents: component.bundledComponents,
      compatibleProtocol: "butler.app.v1",
      updatePolicy: component.updatePolicy,
      restartPolicy: component.restartPolicy,
    })),
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
  if (manifest.protocol !== "butler.app.v1")
    issues.push("app release protocol must be butler.app.v1");
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
): string {
  return `butler-app-${version}-darwin-arm64.zip`;
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
    if (component.version !== versions.app) {
      issues.push(`component ${component.id} version source mismatch`);
    }
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
  for (const artifact of manifest.artifacts) {
    if (!APP_RELEASE_COMPONENT_IDS.includes(artifact.component)) {
      issues.push(
        `unknown app release artifact component: ${artifact.component}`,
      );
      continue;
    }
    artifactComponents.add(artifact.component);
    const component = manifest.components.find(
      (item) => item.id === artifact.component,
    );
    if (!component) continue;
    if (artifact.version !== component.version) {
      issues.push(`artifact ${artifact.component} version mismatch`);
    }
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
  }
}

function sameComponentSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}
