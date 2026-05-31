import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createReleaseManifest } from "../release/manifest.ts";

export const UPDATE_COMPONENT_IDS = ["service", "app"] as const;
export type UpdateComponentId = (typeof UPDATE_COMPONENT_IDS)[number];
export type ReleaseRestartPolicy =
  | "restart-service"
  | "restart-app";
export type ReleaseUpdatePolicy = "explicit" | "app-user-action";

interface ComponentVersions {
  service: string;
  app: string;
}

export interface ComponentUpdateStatus {
  component: UpdateComponentId;
  current_version: string;
  available_version: string;
  update_available: boolean;
  channel: string;
  artifact_url: string | null;
  sha256: string | null;
  signature: string | null;
  bundled_components: UpdateComponentId[];
  update_policy: ReleaseUpdatePolicy;
  restart_policy: ReleaseRestartPolicy;
  checked_at: string;
  staged: boolean;
  stage_path: string;
  manifest_source: string;
}

export interface UpdateStatusView {
  generated_at: string;
  components: ComponentUpdateStatus[];
  storage_label: "updates";
  manifest_source: string;
  raw_text_included: false;
}

export interface ComponentUpdateApplyResult extends ComponentUpdateStatus {
  dry_run: boolean;
  dryRun: boolean;
  artifact_path: string | null;
  planned_actions: string[];
  stage_status: "up_to_date" | "staged" | "dry_run";
  raw_text_included: false;
}

export interface CheckComponentUpdatesOptions {
  root: string;
  butlerData: string;
  components?: UpdateComponentId[];
  manifestPath?: string | null;
  channel?: string;
  now?: () => Date;
  persist?: boolean;
}

export interface ApplyComponentUpdateOptions {
  root: string;
  butlerData: string;
  component: UpdateComponentId;
  manifestPath?: string | null;
  channel?: string;
  dryRun?: boolean;
  now?: () => Date;
}

type ManifestArtifact = {
  component: UpdateComponentId;
  version: string;
  channel: string;
  artifact_url: string | null;
  sha256: string | null;
  signature: string | null;
  bundled_components: UpdateComponentId[];
  update_policy: ReleaseUpdatePolicy;
  restart_policy: ReleaseRestartPolicy;
};

interface LoadedManifest {
  source: string;
  artifacts: ManifestArtifact[];
}

const UPDATE_STAGE_SCHEMA = "butler.update-stage.v1";
const UPDATE_STATUS_SCHEMA = "butler.update-status.v1";

export async function checkComponentUpdates(
  options: CheckComponentUpdatesOptions,
): Promise<UpdateStatusView> {
  const now = (options.now ?? (() => new Date()))().toISOString();
  const manifest = await loadUpdateManifest(options.root, options.manifestPath, options.channel);
  const components = options.components ?? [...UPDATE_COMPONENT_IDS];
  const statuses = components.map((component) =>
    buildComponentStatus({
      root: options.root,
      butlerData: options.butlerData,
      manifest,
      component,
      channel: options.channel ?? "stable",
      checkedAt: now,
    }),
  );
  const view: UpdateStatusView = {
    generated_at: now,
    components: statuses,
    storage_label: "updates",
    manifest_source: manifest.source,
    raw_text_included: false,
  };
  if (options.persist !== false) writeStatus(options.butlerData, view);
  return view;
}

export async function applyComponentUpdate(
  options: ApplyComponentUpdateOptions,
): Promise<ComponentUpdateApplyResult> {
  const status = (await checkComponentUpdates({
    root: options.root,
    butlerData: options.butlerData,
    components: [options.component],
    manifestPath: options.manifestPath,
    channel: options.channel,
    now: options.now,
  })).components[0];
  if (!status) throw new Error(`Unknown update component: ${options.component}`);
  const plannedActions = plannedActionsFor(status);
  if (options.dryRun) {
    return {
      ...status,
      dry_run: true,
      dryRun: true,
      artifact_path: null,
      planned_actions: plannedActions,
      stage_status: "dry_run",
      raw_text_included: false,
    };
  }
  let artifactPath: string | null = null;
  if (status.update_available) {
    artifactPath = await downloadAndVerifyArtifact(options.butlerData, status);
  }
  const stageStatus = status.update_available ? "staged" : "up_to_date";
  writeStage(options.butlerData, {
    schema: UPDATE_STAGE_SCHEMA,
    component: status.component,
    current_version: status.current_version,
    available_version: status.available_version,
    update_available: status.update_available,
    artifact_url: status.artifact_url,
    artifact_path: artifactPath,
    sha256: status.sha256,
    signature: status.signature,
    bundled_components: status.bundled_components,
    update_policy: status.update_policy,
    restart_policy: status.restart_policy,
    stage_status: stageStatus,
    planned_actions: plannedActions,
    staged_at: status.checked_at,
    raw_text_included: false,
  });
  return {
    ...status,
    staged: true,
    dry_run: false,
    dryRun: false,
    artifact_path: artifactPath,
    planned_actions: plannedActions,
    stage_status: stageStatus,
    raw_text_included: false,
  };
}

export function renderServiceUpdateResult(
  result: ComponentUpdateStatus | ComponentUpdateApplyResult,
): string {
  const current = result.current_version || "unknown";
  const available = result.available_version || "unknown";
  if (!result.update_available) {
    return `Butler service is up to date (${current}).`;
  }
  const applied = "stage_status" in result && result.stage_status === "staged";
  if (applied) {
    return `Butler service update staged: ${current} -> ${available}. Restart the service to apply it.`;
  }
  return `Butler service update available: ${current} -> ${available}.`;
}

function buildComponentStatus(input: {
  root: string;
  butlerData: string;
  manifest: LoadedManifest;
  component: UpdateComponentId;
  channel: string;
  checkedAt: string;
}): ComponentUpdateStatus {
  const current = currentVersion(input.root, input.component);
  const artifact = input.manifest.artifacts.find((item) => item.component === input.component);
  if (!artifact) throw new Error(`Update manifest is missing component: ${input.component}`);
  const available = artifact.version || current;
  return {
    component: input.component,
    current_version: current,
    available_version: available,
    update_available: compareSemver(available, current) > 0,
    channel: artifact.channel || input.channel,
    artifact_url: artifact.artifact_url,
    sha256: artifact.sha256,
    signature: artifact.signature,
    bundled_components: artifact.bundled_components,
    update_policy: artifact.update_policy,
    restart_policy: artifact.restart_policy,
    checked_at: input.checkedAt,
    staged: existsSync(stageFilePath(input.butlerData, input.component)),
    stage_path: stageLabel(input.component),
    manifest_source: input.manifest.source,
  };
}

async function loadUpdateManifest(
  root: string,
  manifestPath?: string | null,
  channel = "stable",
): Promise<LoadedManifest> {
  const source = manifestPath ?? process.env.BUTLER_UPDATE_MANIFEST ?? "";
  if (!source) {
    return {
      source: "local-release-manifest",
      artifacts: localUpdateArtifacts(root),
    };
  }
  const value = await readManifestValue(source);
  return {
    source,
    artifacts: normalizeManifestArtifacts(value, channel),
  };
}

async function readManifestValue(source: string): Promise<unknown> {
  if (/^https?:\/\//u.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Update manifest request failed: ${response.status}`);
    return await response.json();
  }
  const path = source.startsWith("file://") ? new URL(source).pathname : source;
  return JSON.parse(readFileSync(path, "utf8"));
}

function normalizeManifestArtifacts(value: unknown, channel: string): ManifestArtifact[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Update manifest must be a JSON object.");
  }
  const input = value as Record<string, any>;
  const components = new Map<UpdateComponentId, Record<string, any>>();
  for (const component of Array.isArray(input.components) ? input.components : []) {
    const id = component?.id ?? component?.component;
    if (!isUpdateComponentId(id)) throw new Error(`Unknown update component: ${String(id)}`);
    components.set(id, component);
  }
  const artifacts = Array.isArray(input.artifacts)
    ? input.artifacts
    : Array.from(components.values()).map((component) => ({
        component: component.id ?? component.component,
        version: component.version,
        channel,
        artifact_url: component.artifact_url ?? component.downloadUrl ?? component.url ?? null,
        sha256: component.sha256 ?? null,
        signature: component.signature ?? null,
        bundled_components: component.bundled_components ?? component.bundledComponents ?? [component.id ?? component.component],
        update_policy: component.update_policy ?? component.updatePolicy,
        restart_policy: component.restart_policy ?? component.restartPolicy,
      }));
  if (artifacts.length === 0) throw new Error("Update manifest has no artifacts.");
  return artifacts.map((artifact) => normalizeArtifact(artifact, components, channel));
}

function normalizeArtifact(
  artifact: Record<string, any>,
  components: Map<UpdateComponentId, Record<string, any>>,
  channel: string,
): ManifestArtifact {
  const component = artifact.component ?? artifact.id;
  if (!isUpdateComponentId(component)) throw new Error(`Unknown update component: ${String(component)}`);
  const componentEntry = components.get(component);
  const bundled = artifact.bundled_components ??
    artifact.bundledComponents ??
    componentEntry?.bundled_components ??
    componentEntry?.bundledComponents ??
    [component];
  if (!Array.isArray(bundled) || !bundled.every(isUpdateComponentId)) {
    throw new Error(`Invalid bundled components for ${component}`);
  }
  if (component === "service" && !sameComponentSet(bundled, ["service"])) {
    throw new Error("Service update artifact must not bundle app components.");
  }
  if (component === "app" && !sameComponentSet(bundled, ["app"])) {
    throw new Error("App update artifact must not bundle service or gateway host.");
  }
  const version = String(artifact.version ?? componentEntry?.version ?? "");
  if (!version) throw new Error(`Update artifact ${component} is missing a version.`);
  return {
    component,
    version,
    channel: String(artifact.channel ?? componentEntry?.channel ?? channel),
    artifact_url: stringOrNull(artifact.artifact_url ?? artifact.downloadUrl ?? artifact.url),
    sha256: stringOrNull(artifact.sha256),
    signature: stringOrNull(artifact.signature),
    bundled_components: bundled,
    update_policy: normalizeUpdatePolicy(artifact.update_policy ?? artifact.updatePolicy),
    restart_policy: normalizeRestartPolicy(component, artifact.restart_policy ?? artifact.restartPolicy),
  };
}

function currentVersion(root: string, component: UpdateComponentId): string {
  const versions = readComponentVersions(root);
  return versions[component];
}

function readComponentVersions(root: string): ComponentVersions {
  const serviceManifest = createReleaseManifest(root);
  const electronPackage = JSON.parse(readFileSync(
    join(root, "packages", "butler-app", "client", "electron", "package.json"),
    "utf8",
  )) as { version?: unknown };
  return {
    service: serviceManifest.version,
    app: String(electronPackage.version ?? ""),
  };
}

function localUpdateArtifacts(root: string): ManifestArtifact[] {
  const serviceArtifacts = createReleaseManifest(root).artifacts.map((artifact) => ({
    component: artifact.component,
    version: artifact.version,
    channel: artifact.channel,
    artifact_url: artifact.downloadUrl,
    sha256: artifact.sha256,
    signature: artifact.signature,
    bundled_components: artifact.bundledComponents,
    update_policy: artifact.updatePolicy,
    restart_policy: artifact.restartPolicy,
  }));
  const versions = readComponentVersions(root);
  return [
    ...serviceArtifacts,
    {
      component: "app",
      version: versions.app,
      channel: "stable",
      artifact_url: null,
      sha256: null,
      signature: null,
      bundled_components: ["app"],
      update_policy: "app-user-action",
      restart_policy: "restart-app",
    },
  ];
}

function plannedActionsFor(status: ComponentUpdateStatus): string[] {
  if (!status.update_available) {
    return [`${status.component} is already at ${status.current_version}`];
  }
  return [
    `download ${status.component} artifact`,
    "verify artifact sha256",
    `stage ${status.component} update under BUTLER_DATA updates`,
    restartAction(status.restart_policy),
  ];
}

function restartAction(policy: ReleaseRestartPolicy): string {
  if (policy === "restart-app") return "restart app to apply";
  return "restart service to apply";
}

async function downloadAndVerifyArtifact(
  butlerData: string,
  status: ComponentUpdateStatus,
): Promise<string> {
  if (!status.artifact_url) throw new Error(`Update artifact URL is required for ${status.component}.`);
  if (!status.sha256) throw new Error(`Update artifact sha256 is required for ${status.component}.`);
  const bytes = await readArtifactBytes(status.artifact_url);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== status.sha256) {
    throw new Error(`Update artifact checksum mismatch for ${status.component}.`);
  }
  const fileName = safeArtifactName(status.artifact_url, status.component, status.available_version);
  const label = join("updates", "artifacts", fileName);
  atomicWrite(join(butlerData, label), bytes);
  return label;
}

async function readArtifactBytes(url: string): Promise<Buffer> {
  if (/^https?:\/\//u.test(url)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Update artifact request failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  const path = url.startsWith("file://") ? new URL(url).pathname : url;
  return readFileSync(path);
}

function safeArtifactName(url: string, component: UpdateComponentId, version: string): string {
  const parsed = url.startsWith("file://") || /^https?:\/\//u.test(url)
    ? basename(new URL(url).pathname)
    : basename(url);
  return parsed && parsed !== "." ? parsed : `butler-${component}-${version}.artifact`;
}

function writeStatus(butlerData: string, view: UpdateStatusView): void {
  atomicWriteJson(join(butlerData, "updates", "status.json"), {
    schema: UPDATE_STATUS_SCHEMA,
    ...view,
  });
}

function writeStage(butlerData: string, record: Record<string, unknown>): void {
  atomicWriteJson(stageFilePath(butlerData, record.component as UpdateComponentId), record);
}

function stageFilePath(butlerData: string, component: UpdateComponentId): string {
  return join(butlerData, stageLabel(component));
}

function stageLabel(component: UpdateComponentId): string {
  return join("updates", "staged", `${component}.json`);
}

function atomicWriteJson(path: string, value: unknown): void {
  atomicWrite(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function atomicWrite(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split(/[.-]/u).map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(/[.-]/u).map((part) => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length, 3);
  for (let index = 0; index < length; index += 1) {
    const leftValue = Number.isFinite(leftParts[index]) ? leftParts[index]! : 0;
    const rightValue = Number.isFinite(rightParts[index]) ? rightParts[index]! : 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }
  return 0;
}

function isUpdateComponentId(value: unknown): value is UpdateComponentId {
  return typeof value === "string" && UPDATE_COMPONENT_IDS.includes(value as UpdateComponentId);
}

function normalizeUpdatePolicy(value: unknown): ReleaseUpdatePolicy {
  return value === "app-user-action" ? "app-user-action" : "explicit";
}

function normalizeRestartPolicy(
  component: UpdateComponentId,
  value: unknown,
): ReleaseRestartPolicy {
  if (value === "restart-service" || value === "restart-app") {
    return value;
  }
  if (component === "app") return "restart-app";
  return "restart-service";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sameComponentSet(
  left: UpdateComponentId[],
  right: UpdateComponentId[],
): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}
