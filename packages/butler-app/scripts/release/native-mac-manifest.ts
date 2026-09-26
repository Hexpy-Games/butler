import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readAppComponentVersions, validateAppReleaseVersionCoupling, type AppReleaseVersionBaseline } from "./manifest.ts";

export const NATIVE_MAC_PLATFORM = "darwin-arm64";
export const NATIVE_MAC_BINARY = "bundled-agent/bin/butler-agent";
export const NATIVE_MAC_RESOURCES = "bundled-agent/resources";
export const NATIVE_MAC_PAYLOAD_MANIFEST = "bundled-agent/native-agent-manifest.json";
export const NATIVE_MAC_RENDERER = "app-client";

export interface NativeMacReleaseManifest {
  schema: "butler.app-native-mac-release.v1";
  name: "butler-app";
  product: "butler-app";
  version: string;
  bundledAgentVersion: string;
  protocol: "butler.app.v1";
  gatewayProfile: "electron";
  lifecycleMode: "app-foreground";
  updaterOwner: "butler-app";
  registersUserService: false;
  artifacts: Array<{
    product: "butler-app";
    component: "app";
    platform: "darwin-arm64";
    version: string;
    artifactName: string;
    downloadUrl: string | null;
    sha256: string | null;
    updaterArtifactName: string | null;
    updaterSha256: string | null;
    dependencyClosure: NativeMacDependencyClosure | null;
    payloadFormat: "platform-app-package";
    restartPolicy: "restart-app";
    updatePolicy: "app-user-action";
    stagingPolicy: "butler-data-updates";
    activationPolicy: "user-installs-app-package";
    rollbackPolicy: "not-managed-by-butler";
    registersUserService: false;
  }>;
}

export function createNativeMacReleaseManifest(root: string): NativeMacReleaseManifest {
  const versions = readAppComponentVersions(root);
  return {
    schema: "butler.app-native-mac-release.v1",
    name: "butler-app",
    product: "butler-app",
    version: versions.app,
    bundledAgentVersion: versions.bundledAgent,
    protocol: "butler.app.v1",
    gatewayProfile: "electron",
    lifecycleMode: "app-foreground",
    updaterOwner: "butler-app",
    registersUserService: false,
    artifacts: [{
      product: "butler-app",
      component: "app",
      platform: NATIVE_MAC_PLATFORM,
      version: versions.app,
      artifactName: `butler-app-${versions.app}-darwin-arm64.dmg`,
      downloadUrl: null,
      sha256: null,
      updaterArtifactName: null,
      updaterSha256: null,
      dependencyClosure: null,
      payloadFormat: "platform-app-package",
      restartPolicy: "restart-app",
      updatePolicy: "app-user-action",
      stagingPolicy: "butler-data-updates",
      activationPolicy: "user-installs-app-package",
      rollbackPolicy: "not-managed-by-butler",
      registersUserService: false,
    }],
  };
}

export function validateNativeMacReleaseManifest(
  root: string,
  manifest: NativeMacReleaseManifest,
  previous?: AppReleaseVersionBaseline | null,
): string[] {
  const versions = readAppComponentVersions(root);
  const issues = validateAppReleaseVersionCoupling(manifest, previous);
  if (manifest.schema !== "butler.app-native-mac-release.v1" || manifest.product !== "butler-app" || manifest.name !== "butler-app") issues.push("native mac release identity is invalid");
  if (manifest.version !== versions.app || manifest.bundledAgentVersion !== versions.bundledAgent) issues.push("native mac release version mismatch");
  if (manifest.protocol !== "butler.app.v1" || manifest.gatewayProfile !== "electron" || manifest.lifecycleMode !== "app-foreground" || manifest.updaterOwner !== "butler-app" || manifest.registersUserService !== false) issues.push("native mac release ownership is invalid");
  if (manifest.artifacts.length !== 1) issues.push("native mac release requires one App artifact");
  const artifact = manifest.artifacts[0];
  if (!artifact || artifact.platform !== NATIVE_MAC_PLATFORM || artifact.product !== "butler-app" || artifact.component !== "app" || artifact.version !== manifest.version || artifact.registersUserService !== false || artifact.artifactName !== `butler-app-${manifest.version}-darwin-arm64.dmg` || artifact.payloadFormat !== "platform-app-package" || artifact.restartPolicy !== "restart-app" || artifact.updatePolicy !== "app-user-action" || artifact.stagingPolicy !== "butler-data-updates" || artifact.activationPolicy !== "user-installs-app-package" || artifact.rollbackPolicy !== "not-managed-by-butler") issues.push("native mac App artifact contract is invalid");
  for (const path of ["packages/butler-app/client/electron/main.mjs", "packages/butler-app/client/electron/scripts/prepare-native-agent.mjs", "packages/butler-app/client/electron/scripts/normalize-mac-bundle.mjs", "packages/butler-app/client/ui/package.json", "packages/butler-agent/rust/agent/Cargo.toml", "packages/butler-agent/resources"]) {
    if (!existsSync(join(root, path))) issues.push(`native mac release input missing: ${path}`);
  }
  return issues;
}

export interface NativeMacDependencyClosure {
  schema: "butler.app-native-mac-dependency-closure.v1";
  product: "butler-app";
  version: string;
  appVersion: string;
  lifecycleMode: "app-foreground";
  registersUserService: false;
  binary: { path: typeof NATIVE_MAC_BINARY; sha256: string };
  resources: { path: typeof NATIVE_MAC_RESOURCES; sha256: string };
  payloadManifest: { path: typeof NATIVE_MAC_PAYLOAD_MANIFEST; sha256: string };
  renderer: { path: typeof NATIVE_MAC_RENDERER; sha256: string };
}

export function nativeMacDependencyClosure(input: { version: string; appVersion: string; binarySha256: string; resourcesSha256: string; payloadManifestSha256: string; rendererSha256: string }): NativeMacDependencyClosure {
  return {
    schema: "butler.app-native-mac-dependency-closure.v1",
    product: "butler-app",
    version: input.version,
    appVersion: input.appVersion,
    lifecycleMode: "app-foreground",
    registersUserService: false,
    binary: { path: NATIVE_MAC_BINARY, sha256: input.binarySha256 },
    resources: { path: NATIVE_MAC_RESOURCES, sha256: input.resourcesSha256 },
    payloadManifest: { path: NATIVE_MAC_PAYLOAD_MANIFEST, sha256: input.payloadManifestSha256 },
    renderer: { path: NATIVE_MAC_RENDERER, sha256: input.rendererSha256 },
  };
}

export function verifyNativeMacBundle(appPath: string, closure: NativeMacDependencyClosure): void {
  if (!closure || closure.schema !== "butler.app-native-mac-dependency-closure.v1" || closure.product !== "butler-app" || closure.lifecycleMode !== "app-foreground" || closure.registersUserService !== false || closure.binary?.path !== NATIVE_MAC_BINARY || closure.resources?.path !== NATIVE_MAC_RESOURCES || closure.payloadManifest?.path !== NATIVE_MAC_PAYLOAD_MANIFEST || closure.renderer?.path !== NATIVE_MAC_RENDERER) throw new Error("native mac dependency closure is invalid");
  const resources = join(appPath, "Contents", "Resources");
  for (const entry of [closure.binary, closure.payloadManifest]) {
    const path = join(resources, entry.path);
    if (!existsSync(path) || !statSync(path).isFile() || sha256File(path) !== entry.sha256) throw new Error(`native mac bundle file mismatch: ${entry.path}`);
  }
  for (const entry of [closure.resources, closure.renderer]) {
    const path = join(resources, entry.path);
    if (!existsSync(path) || !statSync(path).isDirectory() || sha256Tree(path) !== entry.sha256) throw new Error(`native mac bundle directory mismatch: ${entry.path}`);
  }
  const payload = JSON.parse(readFileSync(join(resources, NATIVE_MAC_PAYLOAD_MANIFEST), "utf8"));
  if (payload.schema !== "butler.native-agent-payload.v1" || payload.version !== closure.version || payload.appVersion !== closure.appVersion || payload.platform !== "darwin" || payload.architecture !== "arm64" || payload.binary !== "bin/butler-agent" || payload.resources !== "resources") throw new Error("native mac payload manifest mismatch");
  if (!existsSync(join(resources, NATIVE_MAC_RENDERER, "index.html"))) throw new Error("native mac renderer index is missing");
  if ((statSync(join(resources, NATIVE_MAC_BINARY)).mode & 0o111) === 0) throw new Error("native mac Agent is not executable");
  for (const entry of [NATIVE_MAC_BINARY, NATIVE_MAC_PAYLOAD_MANIFEST]) {
    if ((statSync(join(resources, entry)).mode & 0o222) !== 0) throw new Error(`native mac payload is writable: ${entry}`);
  }
  for (const retired of ["runtime", "service-installer", "agent-release-manifest.json", "agent-update-manifest.json", "dependency-closure.json"]) {
    if (existsSync(join(resources, "bundled-agent", retired))) throw new Error(`retired native mac payload is present: ${retired}`);
  }
}

export function closureFromNativeMacBundle(
  appPath: string,
  release: Pick<NativeMacReleaseManifest, "version" | "bundledAgentVersion">,
): NativeMacDependencyClosure {
  const resources = join(appPath, "Contents", "Resources");
  return nativeMacDependencyClosure({
    version: release.bundledAgentVersion,
    appVersion: release.version,
    binarySha256: sha256File(join(resources, NATIVE_MAC_BINARY)),
    resourcesSha256: sha256Tree(join(resources, NATIVE_MAC_RESOURCES)),
    payloadManifestSha256: sha256File(join(resources, NATIVE_MAC_PAYLOAD_MANIFEST)),
    rendererSha256: sha256Tree(join(resources, NATIVE_MAC_RENDERER)),
  });
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256Tree(path: string): string {
  const hash = createHash("sha256");
  function walk(root: string, relative = ""): void {
    for (const name of readdirSync(root).sort()) {
      const child = join(root, name);
      const label = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(child);
      if (stat.isDirectory()) { hash.update(`d:${label}\n`); walk(child, label); }
      else if (stat.isSymbolicLink()) hash.update(`l:${label}:${readlinkSync(child)}\n`);
      else if (stat.isFile()) { hash.update(`f:${label}\n`); hash.update(readFileSync(child)); }
      else throw new Error(`unsupported native mac payload entry: ${label}`);
    }
  }
  walk(path);
  return hash.digest("hex");
}
