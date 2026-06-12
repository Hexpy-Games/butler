import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

export const APP_MANAGED_RUNTIME_SCHEMA = "butler.app-managed-agent-runtime.v1";
export const APP_MANAGED_RUNTIME_POINTER_SCHEMA =
  "butler.app-managed-agent-runtime-pointer.v1";

export function appManagedAgentPointerPath(butlerData) {
  return join(butlerData, "app", "runtime", "agent", "current.json");
}

export function resolveBundledAgentResourceRoot({
  env = process.env,
  resourcesPath = process.resourcesPath,
} = {}) {
  const explicit = safeString(env.BUTLER_APP_BUNDLED_AGENT_DIR);
  if (explicit && existsSync(explicit)) return resolve(explicit);
  const packaged = resourcesPath ? join(resourcesPath, "bundled-agent") : "";
  if (packaged && existsSync(packaged)) return packaged;
  return null;
}

export function activateAppManagedAgentRuntime({
  butlerData,
  resourceRoot,
  now = () => new Date(),
}) {
  const prepared = prepareAppManagedAgentRuntime({
    butlerData,
    resourceRoot,
    now,
  });
  prepared.commitActivation();
  return {
    runtimeHome: prepared.runtimeHome,
    runtimeHomeLabel: prepared.runtimeHomeLabel,
    version: prepared.version,
    pointerPath: prepared.pointerPath,
    activated: prepared.activated,
    previousRuntimePath: prepared.previousRuntimePath,
  };
}

export function prepareAppManagedAgentRuntime({
  butlerData,
  resourceRoot,
  now = () => new Date(),
}) {
  const root = resolve(resourceRoot);
  const manifest = readJson(join(root, "agent-release-manifest.json"));
  const artifact = resolveBundledAgentArtifact(manifest);
  const artifactPath = join(root, artifact.artifactName);
  if (!existsSync(artifactPath)) {
    throw new Error("bundled Agent artifact is missing");
  }
  const digest = sha256File(artifactPath);
  if (artifact.sha256 && artifact.sha256 !== digest) {
    throw new Error("bundled Agent artifact digest mismatch");
  }

  const version = safeRuntimeVersionSegment(artifact.version);
  const runtimeHomeLabel = join("app", "runtime", "agent", "versions", version);
  const runtimeHome = join(butlerData, runtimeHomeLabel);
  const currentPointerPath = appManagedAgentPointerPath(butlerData);
  const previousPointer = readJsonIfPresent(currentPointerPath);
  const existingPointer = validPointerForVersion(previousPointer, artifact.version);
  if (existingPointer && runtimeHomeReady(join(butlerData, existingPointer.runtime_home))) {
    return {
      runtimeHome: join(butlerData, existingPointer.runtime_home),
      runtimeHomeLabel: existingPointer.runtime_home,
      version: existingPointer.version,
      pointerPath: currentPointerPath,
      activated: false,
      previousRuntimePath: existingPointer.previous?.runtime_home ?? null,
      commitActivation() {},
    };
  }

  const payloadLabel = join(runtimeHomeLabel, "payloads", artifact.artifactName);
  const payloadPath = join(butlerData, payloadLabel);
  const preparedAt = now().toISOString();
  rmSync(runtimeHome, { recursive: true, force: true });
  mkdirSync(dirname(payloadPath), { recursive: true });
  copyFileSync(artifactPath, payloadPath);
  mkdirSync(runtimeHome, { recursive: true });

  try {
    validateAgentArchiveEntries(artifactPath);
    extractAgentArchive(artifactPath, runtimeHome);
    if (!runtimeHomeReady(runtimeHome)) {
      throw new Error("bundled Agent runtime is missing required files");
    }
    atomicWriteJson(join(runtimeHome, "runtime.json"), {
      schema: APP_MANAGED_RUNTIME_SCHEMA,
      product: "butler-app",
      bundled_agent_product: "butler-agent",
      bundled_agent_version: artifact.version,
      gateway_profile: "electron",
      runtime_home: runtimeHomeLabel,
      payload_path: payloadLabel,
      source_resource_path: root,
      payload_format: "agent-archive",
      activation_policy: "versioned-app-managed-runtime",
      rollback_policy: "preserve-previous-app-managed-runtime",
      prepared_at: preparedAt,
      selected_at: null,
      activation_status: "prepared",
      raw_text_included: false,
    });
    return {
      runtimeHome,
      runtimeHomeLabel,
      version: artifact.version,
      pointerPath: currentPointerPath,
      activated: false,
      previousRuntimePath: previousPointer?.runtime_home ?? null,
      commitActivation() {
        const selectedAt = now().toISOString();
        atomicWriteJson(join(runtimeHome, "runtime.json"), {
          schema: APP_MANAGED_RUNTIME_SCHEMA,
          product: "butler-app",
          bundled_agent_product: "butler-agent",
          bundled_agent_version: artifact.version,
          gateway_profile: "electron",
          runtime_home: runtimeHomeLabel,
          payload_path: payloadLabel,
          source_resource_path: root,
          payload_format: "agent-archive",
          activation_policy: "versioned-app-managed-runtime",
          rollback_policy: "preserve-previous-app-managed-runtime",
          prepared_at: preparedAt,
          selected_at: selectedAt,
          activation_status: "activated",
          raw_text_included: false,
        });
        atomicWriteJson(currentPointerPath, {
          schema: APP_MANAGED_RUNTIME_POINTER_SCHEMA,
          product: "butler-app",
          bundled_agent_product: "butler-agent",
          bundled_agent_version: artifact.version,
          gateway_profile: "electron",
          version: artifact.version,
          runtime_home: runtimeHomeLabel,
          payload_path: payloadLabel,
          selected_at: selectedAt,
          previous: previousPointer,
          raw_text_included: false,
        });
        this.activated = true;
      },
    };
  } catch (error) {
    atomicWriteJson(join(runtimeHome, "runtime.json"), {
      schema: APP_MANAGED_RUNTIME_SCHEMA,
      product: "butler-app",
      bundled_agent_product: "butler-agent",
      bundled_agent_version: artifact.version,
      gateway_profile: "electron",
      runtime_home: runtimeHomeLabel,
      payload_path: payloadLabel,
      source_resource_path: root,
      payload_format: "agent-archive",
      activation_policy: "versioned-app-managed-runtime",
      rollback_policy: "preserve-previous-app-managed-runtime",
      prepared_at: preparedAt,
      selected_at: null,
      activation_status: "rolled_back",
      rollback_reason: error instanceof Error ? error.message : String(error),
      raw_text_included: false,
    });
    throw error;
  }
}

export function resolveAppManagedGatewayCommand({
  butlerData,
  env = process.env,
  resourcesPath = process.resourcesPath,
  resolveRuntime,
} = {}) {
  const resourceRoot = resolveBundledAgentResourceRoot({ env, resourcesPath });
  if (!resourceRoot) return null;
  const activation = prepareAppManagedAgentRuntime({
    butlerData,
    resourceRoot,
  });
  const runtime = resolveRuntime(butlerData);
  const launcher = join(activation.runtimeHome, "bin", "butler.js");
  return {
    command: runtime,
    args: [launcher, "gateway", "app"],
    cwd: activation.runtimeHome,
    appManaged: true,
    bundledAgentVersion: activation.version,
    env: {
      BUTLER_HOME: activation.runtimeHome,
      BUTLER_APP_BUTLER_HOME: activation.runtimeHome,
      BUTLER_DATA: butlerData,
      BUTLER_BUN: runtime,
      BUTLER_APP_MANAGED_RUNTIME_POINTER: activation.pointerPath,
      BUTLER_APP_MANAGED_RUNTIME_HOME: activation.runtimeHome,
    },
    commitActivation: activation.commitActivation,
  };
}

function resolveBundledAgentArtifact(manifest) {
  const artifact = Array.isArray(manifest?.artifacts)
    ? manifest.artifacts.find((item) =>
        item?.product === "butler-agent" ||
        item?.component === "service" ||
        item?.canonicalComponent === "agent",
      )
    : null;
  if (!artifact || typeof artifact !== "object") {
    throw new Error("bundled Agent release manifest is missing an artifact");
  }
  const artifactName = safeString(artifact.artifactName);
  const version = safeString(artifact.version);
  if (!artifactName || !version) {
    throw new Error("bundled Agent artifact metadata is incomplete");
  }
  return {
    artifactName,
    version,
    sha256: safeString(artifact.sha256 ?? artifact.integrity?.digest),
  };
}

function validPointerForVersion(pointer, version) {
  if (
    pointer?.schema !== APP_MANAGED_RUNTIME_POINTER_SCHEMA ||
    pointer.product !== "butler-app" ||
    pointer.gateway_profile !== "electron" ||
    pointer.version !== version ||
    typeof pointer.runtime_home !== "string"
  ) {
    return null;
  }
  return pointer;
}

function runtimeHomeReady(runtimeHome) {
  return (
    existsSync(join(runtimeHome, "bin", "butler.js")) &&
    existsSync(join(runtimeHome, "packages", "butler-agent", "resources", "runtime", "bun-version"))
  );
}

function validateAgentArchiveEntries(artifactPath) {
  const entries = readTarGzEntries(artifactPath);
  if (!entries.some((entry) => normalizeArchiveEntry(entry) === "bin/butler.js")) {
    throw new Error("bundled Agent artifact is missing bin/butler.js");
  }
  for (const entry of entries) {
    const normalized = normalizeArchiveEntry(entry);
    if (!normalized) continue;
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error("bundled Agent artifact contains an unsafe path");
    }
  }
}

function extractAgentArchive(artifactPath, runtimeHome) {
  for (const entry of parseTarGz(artifactPath)) {
    const normalized = normalizeArchiveEntry(entry.name);
    if (!normalized) continue;
    if (entry.type === "directory") {
      mkdirSync(join(runtimeHome, normalized), { recursive: true });
      continue;
    }
    const target = join(runtimeHome, normalized);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data, { mode: entry.mode || 0o644 });
  }
}

function readTarGzEntries(artifactPath) {
  return parseTarGz(artifactPath).map((entry) => entry.name);
}

function parseTarGz(artifactPath) {
  try {
    return parseTarBuffer(gunzipSync(readFileSync(artifactPath)));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("bundled Agent artifact")) {
      throw error;
    }
    throw new Error("bundled Agent artifact extraction failed", { cause: error });
  }
}

function parseTarBuffer(buffer) {
  const entries = [];
  let offset = 0;
  let nextPath = null;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;

    const size = parseOctal(header.subarray(124, 136));
    const typeFlag = String.fromCharCode(header[156] || 0);
    const data = buffer.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (typeFlag === "L") {
      nextPath = trimNull(data.toString("utf8"));
      continue;
    }
    if (typeFlag === "x" || typeFlag === "g") {
      const pax = parsePax(data);
      if (typeFlag === "x" && typeof pax.path === "string") {
        nextPath = pax.path;
      }
      continue;
    }

    const name = nextPath ?? tarHeaderPath(header);
    nextPath = null;
    const normalized = normalizeArchiveEntry(name);
    if (!normalized) continue;
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error("bundled Agent artifact contains an unsafe path");
    }
    if (typeFlag !== "0" && typeFlag !== "\0" && typeFlag !== "" && typeFlag !== "5") {
      throw new Error("bundled Agent artifact contains an unsafe entry type");
    }
    entries.push({
      name: normalized,
      type: typeFlag === "5" ? "directory" : "file",
      mode: parseOctal(header.subarray(100, 108)),
      data,
    });
  }
  return entries;
}

function tarHeaderPath(header) {
  const name = trimNull(header.subarray(0, 100).toString("utf8"));
  const prefix = trimNull(header.subarray(345, 500).toString("utf8"));
  return prefix ? `${prefix}/${name}` : name;
}

function parseOctal(bytes) {
  const text = trimNull(bytes.toString("utf8")).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function parsePax(data) {
  const result = {};
  let cursor = 0;
  const text = data.toString("utf8");
  while (cursor < text.length) {
    const space = text.indexOf(" ", cursor);
    if (space < 0) break;
    const length = Number.parseInt(text.slice(cursor, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, cursor + length - 1);
    const equals = record.indexOf("=");
    if (equals > 0) {
      result[record.slice(0, equals)] = record.slice(equals + 1);
    }
    cursor += length;
  }
  return result;
}

function trimNull(value) {
  return value.replace(/\0.*$/u, "");
}

function normalizeArchiveEntry(entry) {
  return entry.replace(/^\.\/+/u, "").replace(/\/+$/u, "");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tempPath, path);
}

function safeRuntimeVersionSegment(version) {
  const normalized = String(version).trim().replace(/[^0-9A-Za-z._-]+/gu, "-");
  return normalized || "unknown";
}

function safeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
