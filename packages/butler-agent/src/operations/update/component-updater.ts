import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createReleaseManifest } from "../release/manifest.ts";

export const UPDATE_COMPONENT_IDS = ["service", "app"] as const;
export type UpdateComponentId = (typeof UPDATE_COMPONENT_IDS)[number];
export type UpdateComponentAlias = UpdateComponentId | "agent" | "butler-agent" | "butler-app" | "app-server";
export type ReleaseRestartPolicy =
  | "restart-service"
  | "restart-app";
export type ReleaseUpdatePolicy = "explicit" | "app-user-action";
export type UpdateProduct = "butler-agent" | "butler-app";
export type UpdateCanonicalComponent = "agent" | "app";
export type UpdateProfile = "agent-standalone" | "electron";
export type UpdateUpdaterOwner = "butler-agent" | "butler-app";
export type UpdatePayloadFormat = "agent-archive" | "platform-app-package";
export type UpdateStagingPolicy =
  | "butler-data-updates"
  | "platform-updater-cache";
export type UpdateActivationPolicy =
  | "versioned-standalone-runtime"
  | "platform-app-update-then-versioned-app-runtime";
export type UpdateRollbackPolicy =
  | "preserve-previous-standalone-runtime"
  | "preserve-previous-app-managed-runtime";

export interface UpdateIntegrityMetadata {
  digestAlgorithm: "sha256";
  digest: string | null;
  signature: string | null;
}

export type UpdateProtocolCompatibility = {
  protocol: string;
  minimumAgentProtocol?: string;
  maximumAgentProtocol?: string;
  minimumAppProtocol?: string;
  maximumAppProtocol?: string;
};

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
  platform: string | null;
  artifact_url: string | null;
  sha256: string | null;
  signature: string | null;
  bundled_components: UpdateComponentId[];
  bundled_agent_version: string | null;
  product: UpdateProduct;
  canonical_component: UpdateCanonicalComponent;
  profile: UpdateProfile;
  protocol_compatibility: UpdateProtocolCompatibility;
  integrity: UpdateIntegrityMetadata;
  update_policy: ReleaseUpdatePolicy;
  restart_policy: ReleaseRestartPolicy;
  updater_owner: UpdateUpdaterOwner;
  payload_format: UpdatePayloadFormat;
  staging_policy: UpdateStagingPolicy;
  activation_policy: UpdateActivationPolicy;
  rollback_policy: UpdateRollbackPolicy;
  checked_at: string;
  staged: boolean;
  stage_path: string;
  stage_status: "up_to_date" | "staged" | "activated" | "rolled_back" | "dry_run";
  activation_status: "not_required" | "activated" | "rolled_back";
  active_runtime_path: string | null;
  attempted_runtime_path: string | null;
  previous_runtime_path: string | null;
  rollback_reason: string | null;
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
  stage_status: "up_to_date" | "staged" | "activated" | "rolled_back" | "dry_run";
  activation_status: "not_required" | "activated" | "rolled_back";
  active_runtime_path: string | null;
  attempted_runtime_path: string | null;
  previous_runtime_path: string | null;
  rollback_reason: string | null;
  raw_text_included: false;
}

export interface StandaloneAgentActivationContext {
  butlerData: string;
  component: "service";
  version: string;
  artifactPath: string;
  artifactLabel: string;
  runtimeHome: string;
  runtimeHomeLabel: string;
  currentPointerPath: string;
  previousRuntimePath: string | null;
  previousVersion: string | null;
}

export type StandaloneAgentActivationValidator = (
  context: StandaloneAgentActivationContext,
) => void | Promise<void>;

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
  validateStandaloneAgentActivation?: StandaloneAgentActivationValidator;
}

type ManifestArtifact = {
  component: UpdateComponentId;
  version: string;
  channel: string;
  platform: string | null;
  artifact_url: string | null;
  sha256: string | null;
  signature: string | null;
  bundled_components: UpdateComponentId[];
  bundled_agent_version: string | null;
  product: UpdateProduct;
  canonical_component: UpdateCanonicalComponent;
  profile: UpdateProfile;
  protocol_compatibility: UpdateProtocolCompatibility;
  integrity: UpdateIntegrityMetadata;
  update_policy: ReleaseUpdatePolicy;
  restart_policy: ReleaseRestartPolicy;
  updater_owner: UpdateUpdaterOwner;
  payload_format: UpdatePayloadFormat;
  staging_policy: UpdateStagingPolicy;
  activation_policy: UpdateActivationPolicy;
  rollback_policy: UpdateRollbackPolicy;
};

interface LoadedManifest {
  source: string;
  artifacts: ManifestArtifact[];
}

const UPDATE_STAGE_SCHEMA = "butler.update-stage.v1";
const UPDATE_STATUS_SCHEMA = "butler.update-status.v1";
const UPDATE_ACTIVATION_SCHEMA = "butler.update-activation.v1";
const STANDALONE_RUNTIME_SCHEMA = "butler.agent-standalone-runtime.v1";
const STANDALONE_RUNTIME_POINTER_SCHEMA = "butler.agent-standalone-runtime-pointer.v1";

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
      activation_status: "not_required",
      active_runtime_path: null,
      attempted_runtime_path: null,
      previous_runtime_path: null,
      rollback_reason: null,
      raw_text_included: false,
    };
  }
  let artifactPath: string | null = null;
  let activation: StandaloneActivationResult | null = null;
  if (status.update_available) {
    if (status.component === "service") {
      assertGenericUpdaterCanStage(status);
    }
    artifactPath = await downloadAndVerifyArtifact(options.butlerData, status);
    if (status.component === "service") {
      activation = await activateStandaloneAgentUpdate({
        butlerData: options.butlerData,
        status,
        artifactLabel: artifactPath,
        validate: options.validateStandaloneAgentActivation,
      });
    }
  }
  const stageStatus = activation?.stage_status ?? (status.update_available ? "staged" : "up_to_date");
  writeStage(options.butlerData, {
    schema: UPDATE_STAGE_SCHEMA,
    component: status.component,
    current_version: status.current_version,
    available_version: status.available_version,
    update_available: status.update_available,
    platform: status.platform,
    artifact_url: status.artifact_url,
    artifact_path: artifactPath,
    sha256: status.sha256,
    signature: status.signature,
    bundled_components: status.bundled_components,
    bundled_agent_version: status.bundled_agent_version,
    product: status.product,
    canonical_component: status.canonical_component,
    profile: status.profile,
    protocol_compatibility: status.protocol_compatibility,
    integrity: status.integrity,
    update_policy: status.update_policy,
    restart_policy: status.restart_policy,
    updater_owner: status.updater_owner,
    payload_format: status.payload_format,
    staging_policy: status.staging_policy,
    activation_policy: status.activation_policy,
    rollback_policy: status.rollback_policy,
    stage_status: stageStatus,
    activation_status: activation?.activation_status ?? "not_required",
    active_runtime_path: activation?.active_runtime_path ?? null,
    attempted_runtime_path: activation?.attempted_runtime_path ?? null,
    previous_runtime_path: activation?.previous_runtime_path ?? null,
    rollback_reason: activation?.rollback_reason ?? null,
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
    activation_status: activation?.activation_status ?? "not_required",
    active_runtime_path: activation?.active_runtime_path ?? null,
    attempted_runtime_path: activation?.attempted_runtime_path ?? null,
    previous_runtime_path: activation?.previous_runtime_path ?? null,
    rollback_reason: activation?.rollback_reason ?? null,
    raw_text_included: false,
  };
}

export function renderServiceUpdateResult(
  result: ComponentUpdateStatus | ComponentUpdateApplyResult,
): string {
  const current = result.current_version || "unknown";
  const available = result.available_version || "unknown";
  if (!result.update_available) {
    return `Butler Agent is up to date (${current}).`;
  }
  if ("stage_status" in result && result.stage_status === "rolled_back") {
    const reason = result.rollback_reason ? ` ${result.rollback_reason}` : "";
    return `Butler Agent update rolled back: ${current} -> ${available}.${reason}`;
  }
  if ("stage_status" in result && result.stage_status === "activated") {
    return `Butler Agent update activated: ${current} -> ${available}.`;
  }
  if ("stage_status" in result && result.stage_status === "staged") {
    return `Butler Agent update staged: ${current} -> ${available}. Restart Butler Agent to apply it.`;
  }
  return `Butler Agent update available: ${current} -> ${available}.`;
}

interface StandaloneActivationResult {
  stage_status: "staged" | "activated" | "rolled_back";
  activation_status: "not_required" | "activated" | "rolled_back";
  active_runtime_path: string | null;
  attempted_runtime_path: string;
  previous_runtime_path: string | null;
  rollback_reason: string | null;
}

async function activateStandaloneAgentUpdate(input: {
  butlerData: string;
  status: ComponentUpdateStatus;
  artifactLabel: string;
  validate?: StandaloneAgentActivationValidator;
}): Promise<StandaloneActivationResult> {
  const status = input.status;
  if (
    status.component !== "service" ||
    status.profile !== "agent-standalone" ||
    status.activation_policy !== "versioned-standalone-runtime"
  ) {
    return {
      stage_status: "staged",
      activation_status: "not_required",
      active_runtime_path: null,
      attempted_runtime_path: "",
      previous_runtime_path: null,
      rollback_reason: null,
    };
  }

  const versionSegment = safeRuntimeVersionSegment(status.available_version);
  const runtimeHomeLabel = join("runtime", "agent", "versions", versionSegment);
  const runtimeHome = join(input.butlerData, runtimeHomeLabel);
  const payloadLabel = join(runtimeHomeLabel, "payloads", basename(input.artifactLabel));
  const payloadPath = join(input.butlerData, payloadLabel);
  const sourceArtifactPath = join(input.butlerData, input.artifactLabel);
  const currentPointerPath = join(input.butlerData, "runtime", "agent", "current.json");
  const previousPointer = readRuntimePointer(currentPointerPath);
  const previousRuntimePath = previousPointer?.runtime_home ?? null;
  const previousVersion = previousPointer?.version ?? null;

  mkdirSync(dirname(payloadPath), { recursive: true });
  copyFileSync(sourceArtifactPath, payloadPath);
  atomicWriteJson(join(runtimeHome, "runtime.json"), {
    schema: STANDALONE_RUNTIME_SCHEMA,
    component: status.component,
    product: status.product,
    canonical_component: status.canonical_component,
    profile: status.profile,
    version: status.available_version,
    runtime_home: runtimeHomeLabel,
    payload_path: payloadLabel,
    source_artifact_path: input.artifactLabel,
    payload_format: status.payload_format,
    activation_policy: status.activation_policy,
    rollback_policy: status.rollback_policy,
    prepared_at: status.checked_at,
    selected_at: null,
    activation_status: "prepared",
    raw_text_included: false,
  });

  const context: StandaloneAgentActivationContext = {
    butlerData: input.butlerData,
    component: "service",
    version: status.available_version,
    artifactPath: sourceArtifactPath,
    artifactLabel: input.artifactLabel,
    runtimeHome,
    runtimeHomeLabel,
    currentPointerPath,
    previousRuntimePath,
    previousVersion,
  };

  try {
    validatePreparedStandaloneRuntime(context);
    await input.validate?.(context);
    const currentPointer = {
      schema: STANDALONE_RUNTIME_POINTER_SCHEMA,
      component: status.component,
      product: status.product,
      canonical_component: status.canonical_component,
      profile: status.profile,
      version: status.available_version,
      runtime_home: runtimeHomeLabel,
      payload_path: payloadLabel,
      source_artifact_path: input.artifactLabel,
      selected_at: status.checked_at,
      previous: previousPointer,
      raw_text_included: false,
    };
    atomicWriteJson(join(runtimeHome, "runtime.json"), {
      schema: STANDALONE_RUNTIME_SCHEMA,
      component: status.component,
      product: status.product,
      canonical_component: status.canonical_component,
      profile: status.profile,
      version: status.available_version,
      runtime_home: runtimeHomeLabel,
      payload_path: payloadLabel,
      source_artifact_path: input.artifactLabel,
      payload_format: status.payload_format,
      activation_policy: status.activation_policy,
      rollback_policy: status.rollback_policy,
      prepared_at: status.checked_at,
      selected_at: status.checked_at,
      activation_status: "activated",
      raw_text_included: false,
    });
    atomicWriteJson(currentPointerPath, currentPointer);
    writeActivationRecord(input.butlerData, {
      status,
      activationStatus: "activated",
      runtimeHomeLabel,
      payloadLabel,
      previousRuntimePath,
      rollbackReason: null,
    });
    return {
      stage_status: "activated",
      activation_status: "activated",
      active_runtime_path: runtimeHomeLabel,
      attempted_runtime_path: runtimeHomeLabel,
      previous_runtime_path: previousRuntimePath,
      rollback_reason: null,
    };
  } catch (error) {
    const rollbackReason = error instanceof Error ? error.message : String(error);
    atomicWriteJson(join(runtimeHome, "runtime.json"), {
      schema: STANDALONE_RUNTIME_SCHEMA,
      component: status.component,
      product: status.product,
      canonical_component: status.canonical_component,
      profile: status.profile,
      version: status.available_version,
      runtime_home: runtimeHomeLabel,
      payload_path: payloadLabel,
      source_artifact_path: input.artifactLabel,
      payload_format: status.payload_format,
      activation_policy: status.activation_policy,
      rollback_policy: status.rollback_policy,
      prepared_at: status.checked_at,
      selected_at: null,
      activation_status: "rolled_back",
      rollback_reason: rollbackReason,
      raw_text_included: false,
    });
    writeActivationRecord(input.butlerData, {
      status,
      activationStatus: "rolled_back",
      runtimeHomeLabel,
      payloadLabel,
      previousRuntimePath,
      rollbackReason,
    });
    return {
      stage_status: "rolled_back",
      activation_status: "rolled_back",
      active_runtime_path: previousRuntimePath,
      attempted_runtime_path: runtimeHomeLabel,
      previous_runtime_path: previousRuntimePath,
      rollback_reason: rollbackReason,
    };
  }
}

function validatePreparedStandaloneRuntime(context: StandaloneAgentActivationContext): void {
  if (!existsSync(context.artifactPath)) {
    throw new Error("prepared Agent artifact is missing");
  }
  if (!existsSync(context.runtimeHome)) {
    throw new Error("prepared Agent runtime home is missing");
  }
  validateAgentArchiveEntries(context.artifactPath);
  const extract = spawnSync("tar", ["-xzf", context.artifactPath, "-C", context.runtimeHome], {
    encoding: "utf8",
  });
  if (extract.status !== 0) {
    throw new Error(`startup check failed: ${summarizeProcessFailure(extract) || "artifact extraction failed"}`);
  }
  const launcherPath = join(context.runtimeHome, "bin", "butler.js");
  if (!existsSync(launcherPath)) {
    throw new Error("startup check failed: Agent launcher is missing");
  }
  const activationEnv = {
    ...process.env,
    BUTLER_HOME: context.runtimeHome,
    BUTLER_DATA: context.butlerData,
    BUTLER_UPDATE_ACTIVATION_CHECK: "1",
  };
  const startup = spawnSync(process.execPath, [launcherPath, "--help"], {
    cwd: context.runtimeHome,
    encoding: "utf8",
    env: activationEnv,
    timeout: 30_000,
  });
  if (startup.status !== 0) {
    throw new Error(`startup check failed: ${summarizeProcessFailure(startup) || "Agent launcher failed"}`);
  }
  const doctor = spawnSync(process.execPath, [launcherPath, "doctor", "--json"], {
    cwd: context.runtimeHome,
    encoding: "utf8",
    env: activationEnv,
    timeout: 30_000,
  });
  if (doctor.status !== 0) {
    throw new Error(`doctor check failed: ${summarizeProcessFailure(doctor) || "Agent doctor failed"}`);
  }
}

function validateAgentArchiveEntries(artifactPath: string): void {
  const verboseListing = spawnSync("tar", ["-tvzf", artifactPath], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (verboseListing.status !== 0) {
    throw new Error(`startup check failed: ${summarizeProcessFailure(verboseListing) || "artifact listing failed"}`);
  }
  for (const line of verboseListing.stdout.split(/\r?\n/u).filter(Boolean)) {
    const entryType = line[0];
    if (entryType !== "-" && entryType !== "d") {
      throw new Error("startup check failed: Agent artifact contains an unsafe entry type");
    }
  }
  const listing = spawnSync("tar", ["-tzf", artifactPath], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (listing.status !== 0) {
    throw new Error(`startup check failed: ${summarizeProcessFailure(listing) || "artifact listing failed"}`);
  }
  const entries = listing.stdout.split(/\r?\n/u).filter(Boolean);
  if (!entries.some((entry) => normalizeArchiveEntry(entry) === "bin/butler.js")) {
    throw new Error("startup check failed: Agent launcher is missing from artifact");
  }
  for (const entry of entries) {
    const normalized = normalizeArchiveEntry(entry);
    if (!normalized) continue;
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error("startup check failed: Agent artifact contains an unsafe path");
    }
  }
}

function normalizeArchiveEntry(entry: string): string {
  return entry.replace(/^\.\/+/u, "").replace(/\/+$/u, "");
}

function summarizeProcessFailure(result: ReturnType<typeof spawnSync>): string {
  if (result.error) return result.error.message;
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  if (stderr) return stderr.split(/\r?\n/u)[0] ?? stderr;
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (stdout) return stdout.split(/\r?\n/u)[0] ?? stdout;
  if (typeof result.status === "number") return `exit ${result.status}`;
  if (result.signal) return `signal ${result.signal}`;
  return "";
}

function writeActivationRecord(
  butlerData: string,
  input: {
    status: ComponentUpdateStatus;
    activationStatus: "activated" | "rolled_back";
    runtimeHomeLabel: string;
    payloadLabel: string;
    previousRuntimePath: string | null;
    rollbackReason: string | null;
  },
): void {
  atomicWriteJson(join(butlerData, "updates", "activation", `${input.status.component}.json`), {
    schema: UPDATE_ACTIVATION_SCHEMA,
    component: input.status.component,
    product: input.status.product,
    canonical_component: input.status.canonical_component,
    profile: input.status.profile,
    version: input.status.available_version,
    activation_status: input.activationStatus,
    active_runtime_path: input.activationStatus === "activated"
      ? input.runtimeHomeLabel
      : input.previousRuntimePath,
    attempted_runtime_path: input.runtimeHomeLabel,
    previous_runtime_path: input.previousRuntimePath,
    payload_path: input.payloadLabel,
    activation_policy: input.status.activation_policy,
    rollback_policy: input.status.rollback_policy,
    rollback_reason: input.rollbackReason,
    checked_at: input.status.checked_at,
    raw_text_included: false,
  });
}

function readRuntimePointer(path: string): Record<string, any> | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, any>;
  } catch {
    return null;
  }
}

function safeRuntimeVersionSegment(version: string): string {
  const normalized = version.trim().replace(/[^0-9A-Za-z._-]+/gu, "-");
  return normalized || "unknown";
}

function buildComponentStatus(input: {
  root: string;
  butlerData: string;
  manifest: LoadedManifest;
  component: UpdateComponentId;
  channel: string;
  checkedAt: string;
}): ComponentUpdateStatus {
  const current = currentVersion(input.root, input.butlerData, input.component);
  const artifact = selectManifestArtifact(input.manifest.artifacts, input.component);
  if (!artifact) throw new Error(`Update manifest is missing component: ${input.component}`);
  const available = artifact.version || current;
  const stage = readStageSnapshot(input.butlerData, input.component);
  return {
    component: input.component,
    current_version: current,
    available_version: available,
    update_available: compareSemver(available, current) > 0,
    channel: artifact.channel || input.channel,
    platform: artifact.platform,
    artifact_url: artifact.artifact_url,
    sha256: artifact.sha256,
    signature: artifact.signature,
    bundled_components: artifact.bundled_components,
    bundled_agent_version: artifact.bundled_agent_version,
    product: artifact.product,
    canonical_component: artifact.canonical_component,
    profile: artifact.profile,
    protocol_compatibility: artifact.protocol_compatibility,
    integrity: artifact.integrity,
    update_policy: artifact.update_policy,
    restart_policy: artifact.restart_policy,
    updater_owner: artifact.updater_owner,
    payload_format: artifact.payload_format,
    staging_policy: artifact.staging_policy,
    activation_policy: artifact.activation_policy,
    rollback_policy: artifact.rollback_policy,
    checked_at: input.checkedAt,
    staged: stage.exists,
    stage_path: stageLabel(input.component),
    stage_status: stage.stage_status,
    activation_status: stage.activation_status,
    active_runtime_path: stage.active_runtime_path,
    attempted_runtime_path: stage.attempted_runtime_path,
    previous_runtime_path: stage.previous_runtime_path,
    rollback_reason: stage.rollback_reason,
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
    const normalizedId = normalizeUpdateComponentId(id);
    if (!normalizedId) throw new Error(`Unknown update component: ${String(id)}`);
    components.set(normalizedId, {
      ...component,
      id: normalizedId,
      component: normalizedId,
    });
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
        bundled_agent_version: component.bundled_agent_version ?? component.bundledAgentVersion ?? null,
        product: component.product,
        canonical_component: component.canonical_component ?? component.canonicalComponent,
        profile: component.profile,
        protocol_compatibility: component.protocol_compatibility ?? component.protocolCompatibility,
        integrity: component.integrity,
        update_policy: component.update_policy ?? component.updatePolicy,
        restart_policy: component.restart_policy ?? component.restartPolicy,
        updater_owner: component.updater_owner ?? component.updaterOwner,
        payload_format: component.payload_format ?? component.payloadFormat,
        staging_policy: component.staging_policy ?? component.stagingPolicy,
        activation_policy: component.activation_policy ?? component.activationPolicy,
        rollback_policy: component.rollback_policy ?? component.rollbackPolicy,
      }));
  if (artifacts.length === 0) throw new Error("Update manifest has no artifacts.");
  return artifacts.map((artifact) => normalizeArtifact(artifact, components, channel));
}

function normalizeArtifact(
  artifact: Record<string, any>,
  components: Map<UpdateComponentId, Record<string, any>>,
  channel: string,
): ManifestArtifact {
  const rawComponent = artifact.component ?? artifact.id;
  const component = normalizeUpdateComponentId(rawComponent);
  if (!component) throw new Error(`Unknown update component: ${String(rawComponent)}`);
  const componentEntry = components.get(component);
  const rawBundled = artifact.bundled_components ??
    artifact.bundledComponents ??
    componentEntry?.bundled_components ??
    componentEntry?.bundledComponents ??
    [component];
  const bundled = Array.isArray(rawBundled)
    ? rawBundled.map((item) => normalizeUpdateComponentId(item))
    : rawBundled;
  if (!Array.isArray(bundled) || !bundled.every(isUpdateComponentId)) {
    throw new Error(`Invalid bundled components for ${component}`);
  }
  if (component === "service" && !sameComponentSet(bundled, ["service"])) {
    throw new Error("Butler Agent update artifact must not bundle app components.");
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
    platform: normalizeArtifactPlatform(
      component,
      artifact.platform ?? componentEntry?.platform,
    ),
    artifact_url: stringOrNull(artifact.artifact_url ?? artifact.downloadUrl ?? artifact.url),
    sha256: stringOrNull(artifact.sha256),
    signature: stringOrNull(artifact.signature),
    bundled_components: bundled,
    bundled_agent_version: component === "app"
      ? stringOrNull(
          artifact.bundled_agent_version ??
            artifact.bundledAgentVersion ??
            componentEntry?.bundled_agent_version ??
            componentEntry?.bundledAgentVersion,
        )
      : null,
    product: normalizeProduct(component, artifact.product ?? componentEntry?.product),
    canonical_component: normalizeCanonicalComponent(
      component,
      artifact.canonical_component ?? artifact.canonicalComponent ?? componentEntry?.canonical_component ?? componentEntry?.canonicalComponent,
    ),
    profile: normalizeProfile(component, artifact.profile ?? componentEntry?.profile),
    protocol_compatibility: normalizeProtocolCompatibility(
      component,
      artifact.protocol_compatibility ?? artifact.protocolCompatibility ?? componentEntry?.protocol_compatibility ?? componentEntry?.protocolCompatibility,
    ),
    integrity: normalizeIntegrity(
      artifact.integrity ?? componentEntry?.integrity,
      stringOrNull(artifact.sha256),
      stringOrNull(artifact.signature),
    ),
    update_policy: normalizeUpdatePolicy(artifact.update_policy ?? artifact.updatePolicy),
    restart_policy: normalizeRestartPolicy(component, artifact.restart_policy ?? artifact.restartPolicy),
    updater_owner: normalizeUpdaterOwner(component, artifact.updater_owner ?? artifact.updaterOwner ?? componentEntry?.updater_owner ?? componentEntry?.updaterOwner),
    payload_format: normalizePayloadFormat(component, artifact.payload_format ?? artifact.payloadFormat ?? componentEntry?.payload_format ?? componentEntry?.payloadFormat),
    staging_policy: normalizeStagingPolicy(component, artifact.staging_policy ?? artifact.stagingPolicy ?? componentEntry?.staging_policy ?? componentEntry?.stagingPolicy),
    activation_policy: normalizeActivationPolicy(component, artifact.activation_policy ?? artifact.activationPolicy ?? componentEntry?.activation_policy ?? componentEntry?.activationPolicy),
    rollback_policy: normalizeRollbackPolicy(component, artifact.rollback_policy ?? artifact.rollbackPolicy ?? componentEntry?.rollback_policy ?? componentEntry?.rollbackPolicy),
  };
}

function selectManifestArtifact(
  artifacts: ManifestArtifact[],
  component: UpdateComponentId,
): ManifestArtifact | null {
  const candidates = artifacts.filter((item) => item.component === component);
  if (candidates.length === 0) return null;
  if (component === "service") {
    return candidates.find((item) => !item.platform || item.platform === "all") ??
      candidates[0]!;
  }
  const currentPlatform = currentAppUpdatePlatform();
  const exact = candidates.find((item) => item.platform === currentPlatform);
  if (exact) return exact;
  const legacy = candidates.find((item) => !item.platform);
  if (legacy) return legacy;
  throw new Error(`Update manifest is missing app artifact for platform: ${currentPlatform}`);
}

function currentVersion(root: string, butlerData: string, component: UpdateComponentId): string {
  if (component === "service") {
    const pointer = readRuntimePointer(join(butlerData, "runtime", "agent", "current.json"));
    if (
      pointer?.schema === STANDALONE_RUNTIME_POINTER_SCHEMA &&
      pointer.product === "butler-agent" &&
      pointer.profile === "agent-standalone" &&
      typeof pointer.version === "string" &&
      pointer.version.trim()
    ) {
      return pointer.version.trim();
    }
    return createReleaseManifest(root).version;
  }
  const versions = readComponentVersions(root);
  return versions[component];
}

function readStageSnapshot(
  butlerData: string,
  component: UpdateComponentId,
): {
  exists: boolean;
  stage_status: ComponentUpdateStatus["stage_status"];
  activation_status: ComponentUpdateStatus["activation_status"];
  active_runtime_path: string | null;
  attempted_runtime_path: string | null;
  previous_runtime_path: string | null;
  rollback_reason: string | null;
} {
  const path = stageFilePath(butlerData, component);
  if (!existsSync(path)) {
    return {
      exists: false,
      stage_status: "up_to_date",
      activation_status: "not_required",
      active_runtime_path: null,
      attempted_runtime_path: null,
      previous_runtime_path: null,
      rollback_reason: null,
    };
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      exists: true,
      stage_status: normalizeStageStatus(value.stage_status),
      activation_status: normalizeActivationStatus(value.activation_status),
      active_runtime_path: stringOrNull(value.active_runtime_path),
      attempted_runtime_path: stringOrNull(value.attempted_runtime_path),
      previous_runtime_path: stringOrNull(value.previous_runtime_path),
      rollback_reason: stringOrNull(value.rollback_reason),
    };
  } catch {
    return {
      exists: true,
      stage_status: "staged",
      activation_status: "not_required",
      active_runtime_path: null,
      attempted_runtime_path: null,
      previous_runtime_path: null,
      rollback_reason: null,
    };
  }
}

function normalizeStageStatus(value: unknown): ComponentUpdateStatus["stage_status"] {
  if (
    value === "up_to_date" ||
    value === "staged" ||
    value === "activated" ||
    value === "rolled_back" ||
    value === "dry_run"
  ) {
    return value;
  }
  return "staged";
}

function normalizeActivationStatus(value: unknown): ComponentUpdateStatus["activation_status"] {
  if (value === "activated" || value === "rolled_back" || value === "not_required") {
    return value;
  }
  return "not_required";
}

function readComponentVersions(root: string): ComponentVersions {
  const serviceManifest = createReleaseManifest(root);
  return {
    service: serviceManifest.version,
    app: readAppVersion(root),
  };
}

function localUpdateArtifacts(root: string): ManifestArtifact[] {
  const serviceArtifacts = createReleaseManifest(root).artifacts.map((artifact) => ({
    component: artifact.component,
    version: artifact.version,
    channel: artifact.channel,
    platform: artifact.platform,
    artifact_url: artifact.downloadUrl,
    sha256: artifact.sha256,
    signature: artifact.signature,
    bundled_components: artifact.bundledComponents,
    bundled_agent_version: null,
    product: artifact.product,
    canonical_component: artifact.canonicalComponent,
    profile: artifact.profile,
    protocol_compatibility: artifact.protocolCompatibility,
    integrity: artifact.integrity,
    update_policy: artifact.updatePolicy,
    restart_policy: artifact.restartPolicy,
    updater_owner: artifact.updaterOwner,
    payload_format: artifact.payloadFormat,
    staging_policy: artifact.stagingPolicy,
    activation_policy: artifact.activationPolicy,
    rollback_policy: artifact.rollbackPolicy,
  }));
  const versions = readComponentVersions(root);
  const artifacts: ManifestArtifact[] = [...serviceArtifacts];
  if (versions.app) artifacts.push(localAppUpdateArtifact(versions.app, versions.service));
  return artifacts;
}

function readAppVersion(root: string): string {
  try {
    const electronPackage = JSON.parse(readFileSync(
      join(root, "packages", "butler-app", "client", "electron", "package.json"),
      "utf8",
    )) as { version?: unknown };
    return String(electronPackage.version ?? "");
  } catch {
    return "";
  }
}

function localAppUpdateArtifact(version: string, bundledAgentVersion: string): ManifestArtifact {
  return {
    component: "app",
    version,
    channel: "stable",
    platform: currentAppUpdatePlatform(),
    artifact_url: null,
    sha256: null,
    signature: null,
    bundled_components: ["app"],
    bundled_agent_version: bundledAgentVersion || null,
    product: "butler-app",
    canonical_component: "app",
    profile: "electron",
    protocol_compatibility: {
      protocol: "butler.app.v1",
      minimumAppProtocol: "butler.app.v1",
      maximumAppProtocol: "butler.app.v1",
    },
    integrity: {
      digestAlgorithm: "sha256",
      digest: null,
      signature: null,
    },
    update_policy: "app-user-action",
    restart_policy: "restart-app",
    updater_owner: "butler-app",
    payload_format: "platform-app-package",
    staging_policy: "platform-updater-cache",
    activation_policy: "platform-app-update-then-versioned-app-runtime",
    rollback_policy: "preserve-previous-app-managed-runtime",
  };
}

function plannedActionsFor(status: ComponentUpdateStatus): string[] {
  const label = updateComponentLabel(status.component);
  if (!status.update_available) {
    return [`${label} is already at ${status.current_version}`];
  }
  return [
    `download ${label} artifact`,
    "verify artifact sha256",
    status.staging_policy === "butler-data-updates"
      ? `stage ${label} update under BUTLER_DATA updates`
      : `stage ${label} update for ${status.staging_policy} handoff`,
    `activate with ${status.activation_policy}`,
    `rollback with ${status.rollback_policy} on failure`,
    restartAction(status.restart_policy),
  ];
}

function restartAction(policy: ReleaseRestartPolicy): string {
  if (policy === "restart-app") return "restart Butler App to apply";
  return "restart Butler Agent to apply";
}

function assertGenericUpdaterCanStage(status: ComponentUpdateStatus): void {
  if (status.staging_policy === "butler-data-updates") return;
  throw new Error(
    `${status.component} updates use ${status.staging_policy}; generic BUTLER_DATA staging is not allowed.`,
  );
}

function normalizeProduct(
  component: UpdateComponentId,
  value: unknown,
): UpdateProduct {
  const expected = component === "service" ? "butler-agent" : "butler-app";
  if (value == null) return expected;
  if (value === expected) return expected;
  throw new Error(`Update artifact ${component} product must be ${expected}.`);
}

function normalizeArtifactPlatform(
  component: UpdateComponentId,
  value: unknown,
): string | null {
  if (value == null) return component === "service" ? "all" : null;
  if (typeof value !== "string") {
    throw new Error(`Update artifact ${component} platform must be a string.`);
  }
  const platform = value.trim();
  if (!platform) return component === "service" ? "all" : null;
  return platform;
}

function currentAppUpdatePlatform(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch;
  return `${os}-${arch}`;
}

function normalizeCanonicalComponent(
  component: UpdateComponentId,
  value: unknown,
): UpdateCanonicalComponent {
  const expected = component === "service" ? "agent" : "app";
  if (value == null) return expected;
  if (value === expected) return expected;
  throw new Error(`Update artifact ${component} canonical component must be ${expected}.`);
}

function normalizeProfile(
  component: UpdateComponentId,
  value: unknown,
): UpdateProfile {
  const expected = component === "service" ? "agent-standalone" : "electron";
  if (value == null) return expected;
  if (value === expected) return expected;
  throw new Error(`Update artifact ${component} profile must be ${expected}.`);
}

function normalizeProtocolCompatibility(
  component: UpdateComponentId,
  value: unknown,
): UpdateProtocolCompatibility {
  const expected: UpdateProtocolCompatibility = component === "service"
    ? {
        protocol: "butler.agent.v1",
        minimumAgentProtocol: "butler.agent.v1",
        maximumAgentProtocol: "butler.agent.v1",
      }
    : {
        protocol: "butler.app.v1",
        minimumAppProtocol: "butler.app.v1",
        maximumAppProtocol: "butler.app.v1",
      };
  if (value == null) return expected;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Update artifact ${component} protocol compatibility must be an object.`);
  }
  const candidate = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (candidate[key] !== expectedValue) {
      throw new Error(
        `Update artifact ${component} protocol compatibility ${key} must be ${expectedValue}.`,
      );
    }
  }
  return expected;
}

function normalizeIntegrity(
  value: unknown,
  sha256: string | null,
  signature: string | null,
): UpdateIntegrityMetadata {
  if (value == null) {
    if (signature) {
      throw new Error(
        "Update artifact signature verification is not implemented; signed artifacts must fail closed.",
      );
    }
    return {
      digestAlgorithm: "sha256",
      digest: sha256,
      signature,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Update artifact integrity metadata must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.digestAlgorithm !== "sha256") {
    throw new Error("Update artifact integrity digest algorithm must be sha256.");
  }
  const normalizedSignature = stringOrNull(candidate.signature) ?? signature;
  if (normalizedSignature) {
    throw new Error(
      "Update artifact signature verification is not implemented; signed artifacts must fail closed.",
    );
  }
  return {
    digestAlgorithm: "sha256",
    digest: stringOrNull(candidate.digest) ?? sha256,
    signature: null,
  };
}

function normalizeUpdaterOwner(
  component: UpdateComponentId,
  value: unknown,
): UpdateUpdaterOwner {
  const expected = component === "service" ? "butler-agent" : "butler-app";
  if (value == null) return expected;
  if (value === expected) return expected;
  throw new Error(`Update artifact ${component} updater owner must be ${expected}.`);
}

function normalizePayloadFormat(
  component: UpdateComponentId,
  value: unknown,
): UpdatePayloadFormat {
  const expected = component === "service" ? "agent-archive" : "platform-app-package";
  if (value == null) return expected;
  if (value === expected) return expected;
  throw new Error(`Update artifact ${component} payload format must be ${expected}.`);
}

function normalizeStagingPolicy(
  component: UpdateComponentId,
  value: unknown,
): UpdateStagingPolicy {
  const expected = component === "service" ? "butler-data-updates" : "platform-updater-cache";
  if (value == null) return expected;
  if (value === expected) return expected;
  throw new Error(`Update artifact ${component} staging policy must be ${expected}.`);
}

function normalizeActivationPolicy(
  component: UpdateComponentId,
  value: unknown,
): UpdateActivationPolicy {
  const expected = component === "service"
    ? "versioned-standalone-runtime"
    : "platform-app-update-then-versioned-app-runtime";
  if (value == null) return expected;
  if (value === expected) return expected;
  throw new Error(`Update artifact ${component} activation policy must be ${expected}.`);
}

function normalizeRollbackPolicy(
  component: UpdateComponentId,
  value: unknown,
): UpdateRollbackPolicy {
  const expected = component === "service"
    ? "preserve-previous-standalone-runtime"
    : "preserve-previous-app-managed-runtime";
  if (value == null) return expected;
  if (value === expected) return expected;
  throw new Error(`Update artifact ${component} rollback policy must be ${expected}.`);
}

async function downloadAndVerifyArtifact(
  butlerData: string,
  status: ComponentUpdateStatus,
): Promise<string> {
  if (!status.artifact_url) throw new Error(`Update artifact URL is required for ${status.component}.`);
  if (!status.sha256) throw new Error(`Update artifact sha256 is required for ${status.component}.`);
  const fileName = safeArtifactName(status.artifact_url, status.component, status.available_version);
  const label = join("updates", "artifacts", fileName);
  const artifactPath = join(butlerData, label);
  const tmp = `${artifactPath}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(dirname(artifactPath), { recursive: true });
  try {
    const digest = await copyArtifactToPath(status.artifact_url, tmp);
    if (digest !== status.sha256) {
      throw new Error(`Update artifact checksum mismatch for ${status.component}.`);
    }
    renameSync(tmp, artifactPath);
  } catch (error) {
    removeIfPresent(tmp);
    throw error;
  }
  return label;
}

async function copyArtifactToPath(url: string, targetPath: string): Promise<string> {
  if (/^https?:\/\//u.test(url)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Update artifact request failed: ${response.status}`);
    if (!response.body) throw new Error("Update artifact response body is empty.");
    const input = Readable.fromWeb(response.body as any);
    return await copyStreamToPathWithHash(input, targetPath);
  }
  const path = url.startsWith("file://") ? new URL(url).pathname : url;
  return await copyStreamToPathWithHash(createReadStream(path), targetPath);
}

async function copyStreamToPathWithHash(
  input: Readable,
  targetPath: string,
): Promise<string> {
  const hash = createHash("sha256");
  const hashStream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(input, hashStream, createWriteStream(targetPath));
  return hash.digest("hex");
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Best effort cleanup for failed update artifact staging.
  }
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

export function normalizeUpdateComponentId(value: unknown): UpdateComponentId | null {
  if (value === "agent" || value === "butler-agent" || value === "service") return "service";
  if (value === "app" || value === "butler-app" || value === "app-server") return "app";
  return null;
}

export function updateComponentLabel(component: UpdateComponentId): "Butler Agent" | "Butler App" {
  return component === "service" ? "Butler Agent" : "Butler App";
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
