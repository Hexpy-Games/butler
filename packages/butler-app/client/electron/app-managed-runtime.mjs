import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

export const APP_MANAGED_RUNTIME_SCHEMA = "butler.app-managed-agent-runtime.v1";
export const APP_MANAGED_RUNTIME_POINTER_SCHEMA =
  "butler.app-managed-agent-runtime-pointer.v1";
export const APP_MANAGED_RUNTIME_UPDATE_TRANSACTION_SCHEMA =
  "butler.app-managed-agent-runtime-update-transaction.v1";
const maxAgentArchiveUncompressedBytes = 2 * 1024 * 1024 * 1024;

export function appManagedAgentPointerPath(butlerData) {
  return join(butlerData, "app", "runtime", "agent", "current.json");
}

export function appManagedAgentUpdateTransactionPath(butlerData) {
  return join(butlerData, "app", "runtime", "agent", "update-transaction.json");
}

export function appManagedAgentCandidateBootTokenPath(butlerData) {
  return join(butlerData, "app", "runtime", "agent", "candidate-boot-token.json");
}

export function beginAppManagedAgentRuntimeUpdate({
  butlerData,
  candidatePointer,
  candidateDigest,
  now = () => new Date(),
  generateToken = () => randomUUID(),
}) {
  const activePointer = readJson(appManagedAgentPointerPath(butlerData));
  if (!validAppManagedPointer(activePointer)) {
    throw new Error("missing active App-managed Agent runtime pointer");
  }
  if (!validAppManagedPointer(candidatePointer)) {
    throw new Error("invalid candidate App-managed Agent runtime pointer");
  }
  const digest = safeString(candidateDigest);
  if (!digest) {
    throw new Error("missing candidate App-managed Agent runtime digest");
  }
  const generation = randomUUID();
  const token = String(generateToken());
  const startedAt = now().toISOString();
  const transaction = {
    schema: APP_MANAGED_RUNTIME_UPDATE_TRANSACTION_SCHEMA,
    generation,
    status: "restart_required",
    previous_active_pointer: activePointer,
    active_pointer: activePointer,
    candidate_pointer: candidatePointer,
    candidate_digest: digest,
    candidate_boot_token_hash: sha256Text(token),
    readiness_proof: null,
    started_at: startedAt,
    updated_at: startedAt,
    last_error: null,
    raw_text_included: false,
  };
  atomicWriteJson(appManagedAgentCandidateBootTokenPath(butlerData), {
    generation,
    candidate_pointer: candidatePointer,
    candidate_digest: digest,
    token,
    raw_text_included: false,
  });
  atomicWriteJson(appManagedAgentUpdateTransactionPath(butlerData), transaction);
  return transaction;
}

export function readAppManagedAgentRuntimeUpdateTransaction(butlerData) {
  return readJsonIfPresent(appManagedAgentUpdateTransactionPath(butlerData));
}

export function recoverAppManagedAgentRuntimeUpdateTransaction({
  butlerData,
  now = () => new Date(),
}) {
  const transaction = readAppManagedAgentRuntimeUpdateTransaction(butlerData);
  if (!transaction) {
    rmSync(appManagedAgentCandidateBootTokenPath(butlerData), { force: true });
    return null;
  }
  const activePointer = readJsonIfPresent(appManagedAgentPointerPath(butlerData));
  if (
    transaction.schema !== APP_MANAGED_RUNTIME_UPDATE_TRANSACTION_SCHEMA ||
    !validAppManagedPointer(transaction.previous_active_pointer) ||
    !validAppManagedPointer(transaction.active_pointer) ||
    !validAppManagedPointer(transaction.candidate_pointer)
  ) {
    throw new Error("invalid App-managed Agent runtime update transaction");
  }

  if (
    transaction.status === "candidate_ready" &&
    sameAppManagedPointer(activePointer, transaction.candidate_pointer)
  ) {
    rmSync(appManagedAgentCandidateBootTokenPath(butlerData), { force: true });
    return writeRecoveredTransaction(butlerData, {
      ...transaction,
      status: "ready",
      active_pointer: activePointer,
      updated_at: now().toISOString(),
      last_error: null,
      raw_text_included: false,
    });
  }

  if (
    transaction.status === "restart_required" &&
    !readJsonIfPresent(appManagedAgentCandidateBootTokenPath(butlerData))
  ) {
    atomicWriteJson(
      appManagedAgentPointerPath(butlerData),
      transaction.previous_active_pointer,
    );
    return writeRecoveredTransaction(butlerData, {
      ...transaction,
      status: "rollback",
      active_pointer: transaction.previous_active_pointer,
      updated_at: now().toISOString(),
      last_error: "recovered missing candidate boot token",
      raw_text_included: false,
    });
  }

  if (
    transaction.status === "restart_required" &&
    activePointer &&
    !sameAppManagedPointer(activePointer, transaction.previous_active_pointer)
  ) {
    atomicWriteJson(
      appManagedAgentPointerPath(butlerData),
      transaction.previous_active_pointer,
    );
    rmSync(appManagedAgentCandidateBootTokenPath(butlerData), { force: true });
    return writeRecoveredTransaction(butlerData, {
      ...transaction,
      status: "rollback",
      active_pointer: transaction.previous_active_pointer,
      updated_at: now().toISOString(),
      last_error: "recovered unready candidate pointer",
      raw_text_included: false,
    });
  }

  if (
    transaction.status === "rollback" &&
    !sameAppManagedPointer(activePointer, transaction.previous_active_pointer)
  ) {
    atomicWriteJson(
      appManagedAgentPointerPath(butlerData),
      transaction.previous_active_pointer,
    );
    rmSync(appManagedAgentCandidateBootTokenPath(butlerData), { force: true });
    return writeRecoveredTransaction(butlerData, {
      ...transaction,
      active_pointer: transaction.previous_active_pointer,
      updated_at: now().toISOString(),
      raw_text_included: false,
    });
  }

  if (
    transaction.status === "ready" &&
    !sameAppManagedPointer(activePointer, transaction.active_pointer)
  ) {
    atomicWriteJson(appManagedAgentPointerPath(butlerData), transaction.active_pointer);
    rmSync(appManagedAgentCandidateBootTokenPath(butlerData), { force: true });
    return writeRecoveredTransaction(butlerData, {
      ...transaction,
      updated_at: now().toISOString(),
      raw_text_included: false,
    });
  }

  return transaction;
}

export function consumeAppManagedAgentCandidateBootToken({
  butlerData,
  generation,
  candidateDigest,
  token,
}) {
  const transaction = requireUpdateTransaction(butlerData, generation);
  if (transaction.status !== "restart_required") {
    throw new Error("candidate App-managed Agent runtime boot is not pending");
  }
  if (transaction.candidate_digest !== safeString(candidateDigest)) {
    throw new Error("candidate App-managed Agent runtime digest mismatch");
  }
  if (transaction.candidate_boot_token_hash !== sha256Text(token)) {
    throw new Error("candidate App-managed Agent runtime boot token mismatch");
  }
  const bootToken = readJsonIfPresent(appManagedAgentCandidateBootTokenPath(butlerData));
  if (
    bootToken?.generation !== generation ||
    bootToken.candidate_digest !== transaction.candidate_digest ||
    !validAppManagedPointer(bootToken.candidate_pointer)
  ) {
    throw new Error("missing candidate App-managed Agent runtime boot token");
  }
  rmSync(appManagedAgentCandidateBootTokenPath(butlerData), { force: true });
  return {
    generation,
    candidate_pointer: transaction.candidate_pointer,
    candidate_digest: transaction.candidate_digest,
    raw_text_included: false,
  };
}

export function markAppManagedAgentRuntimeCandidateReady({
  butlerData,
  generation,
  readinessProof,
  now = () => new Date(),
}) {
  const transaction = requireUpdateTransaction(butlerData, generation);
  const updated = {
    ...transaction,
    status: "candidate_ready",
    readiness_proof: sanitizeUpdateProof(readinessProof),
    updated_at: now().toISOString(),
    last_error: null,
    raw_text_included: false,
  };
  atomicWriteJson(appManagedAgentUpdateTransactionPath(butlerData), updated);
  return updated;
}

export function promoteAppManagedAgentRuntimeCandidate({
  butlerData,
  generation,
  now = () => new Date(),
}) {
  const transaction = requireUpdateTransaction(butlerData, generation);
  if (transaction.status !== "candidate_ready" || !transaction.readiness_proof) {
    throw new Error("candidate App-managed Agent runtime is not ready");
  }
  const selectedAt = now().toISOString();
  const promotedPointer = {
    ...transaction.candidate_pointer,
    selected_at: selectedAt,
    previous: transaction.previous_active_pointer,
    raw_text_included: false,
  };
  atomicWriteJson(appManagedAgentPointerPath(butlerData), promotedPointer);
  const updated = {
    ...transaction,
    status: "ready",
    active_pointer: promotedPointer,
    updated_at: selectedAt,
    last_error: null,
    raw_text_included: false,
  };
  atomicWriteJson(appManagedAgentUpdateTransactionPath(butlerData), updated);
  rmSync(appManagedAgentCandidateBootTokenPath(butlerData), { force: true });
  return updated;
}

export function rollbackAppManagedAgentRuntimeUpdate({
  butlerData,
  generation,
  error = new Error("App-managed Agent runtime update failed"),
  now = () => new Date(),
}) {
  const transaction = requireUpdateTransaction(butlerData, generation);
  const restoredPointer = transaction.previous_active_pointer;
  atomicWriteJson(appManagedAgentPointerPath(butlerData), restoredPointer);
  const updated = {
    ...transaction,
    status: "rollback",
    active_pointer: restoredPointer,
    updated_at: now().toISOString(),
    last_error: redactDiagnosticsText(error instanceof Error ? error.message : String(error)),
    raw_text_included: false,
  };
  atomicWriteJson(appManagedAgentUpdateTransactionPath(butlerData), updated);
  rmSync(appManagedAgentCandidateBootTokenPath(butlerData), { force: true });
  return updated;
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
  const preparedAt = now().toISOString();
  let artifact = null;
  let artifactPath;
  let digest = null;
  let version = "unknown";
  let runtimeHomeLabel = join("app", "runtime", "agent", "versions", version);
  let payloadLabel = join(runtimeHomeLabel, "payloads", "unknown");
  try {
    const manifest = readJson(join(root, "agent-release-manifest.json"));
    artifact = resolveBundledAgentArtifact(manifest);
    version = safeRuntimeVersionSegment(artifact.version);
    runtimeHomeLabel = join("app", "runtime", "agent", "versions", version);
    payloadLabel = join(runtimeHomeLabel, "payloads", artifact.artifactName);
    artifactPath = join(root, artifact.artifactName);
    if (!existsSync(artifactPath)) {
      throw new Error("bundled Agent artifact is missing");
    }
    digest = sha256File(artifactPath);
    if (artifact.sha256 && artifact.sha256 !== digest) {
      throw new Error("bundled Agent artifact digest mismatch");
    }
  } catch (error) {
    writeAppManagedRuntimeFailure({
      butlerData,
      version,
      artifactVersion: artifact?.version ?? "unknown",
      runtimeHomeLabel,
      payloadLabel,
      sourceRoot: root,
      payloadDigest: digest,
      managedRuntimeDigest: null,
      preparedAt,
      error,
    });
    throw error;
  }
  let verifiedClosure;
  try {
    verifiedClosure = verifyDependencyClosure(root, artifact, digest);
  } catch (error) {
    writeAppManagedRuntimeFailure({
      butlerData,
      version,
      artifactVersion: artifact.version,
      runtimeHomeLabel,
      payloadLabel,
      sourceRoot: root,
      payloadDigest: digest,
      managedRuntimeDigest: null,
      preparedAt,
      error,
    });
    throw error;
  }
  const readiness = {
    artifactName: artifact.artifactName,
    artifactPath,
    artifactDigest: digest,
    managedRuntimeDigest: verifiedClosure.managedRuntimeDigest,
  };

  const runtimeHome = join(butlerData, runtimeHomeLabel);
  const currentPointerPath = appManagedAgentPointerPath(butlerData);
  const previousPointer = readJsonIfPresent(currentPointerPath);
  const previousSelectablePointer =
    previousPointer?.runtime_home === runtimeHomeLabel
      ? previousPointer.previous ?? null
      : previousPointer;
  const existingPointer = validPointerForVersion(previousPointer, artifact.version);
  if (
    existingPointer &&
    runtimeHomeReady(join(butlerData, existingPointer.runtime_home), readiness)
  ) {
    return {
      runtimeHome: join(butlerData, existingPointer.runtime_home),
      runtimeHomeLabel: existingPointer.runtime_home,
      version: existingPointer.version,
      pointerPath: currentPointerPath,
      activated: false,
      previousRuntimePath: existingPointer.previous?.runtime_home ?? null,
      commitActivation() {},
      rollbackActivation() {},
    };
  }

  const stagingHome = `${runtimeHome}.staging-${process.pid}-${Date.now()}`;
  const backupHome = `${runtimeHome}.previous-${process.pid}-${Date.now()}`;
  const stagingPayloadPath = join(stagingHome, "payloads", artifact.artifactName);
  let backupCreated = false;
  rmSync(stagingHome, { recursive: true, force: true });
  rmSync(backupHome, { recursive: true, force: true });

  try {
    mkdirSync(dirname(stagingPayloadPath), { recursive: true });
    copyFileSync(artifactPath, stagingPayloadPath);
    const extraction = extractAgentArchive(artifactPath, stagingHome);
    if (!extraction.hasLauncher) {
      throw new Error("bundled Agent artifact is missing bin/butler.js");
    }
    installManagedRuntimePayload(root, stagingHome);
    const readinessIssue = runtimeHomeReadinessIssue(stagingHome, readiness);
    if (readinessIssue) {
      throw new Error(`bundled Agent runtime is missing required files: ${readinessIssue}`);
    }
    atomicWriteJson(join(stagingHome, "runtime.json"), {
      schema: APP_MANAGED_RUNTIME_SCHEMA,
      product: "butler-app",
      bundled_agent_product: "butler-agent",
      bundled_agent_version: artifact.version,
      gateway_profile: "electron",
      runtime_home: runtimeHomeLabel,
      payload_path: payloadLabel,
      source_resource_path: root,
      payload_format: "agent-archive",
      payload_sha256: digest,
      managed_runtime_sha256: verifiedClosure.managedRuntimeDigest,
      activation_policy: "versioned-app-managed-runtime",
      rollback_policy: "preserve-previous-app-managed-runtime",
      prepared_at: preparedAt,
      selected_at: null,
      activation_status: "prepared",
      raw_text_included: false,
    });
    if (existsSync(runtimeHome)) {
      renameSync(runtimeHome, backupHome);
      backupCreated = true;
    }
    renameSync(stagingHome, runtimeHome);
    let rolledBack = false;
    let activationCommitted = false;
    const activation = {
      runtimeHome,
      runtimeHomeLabel,
      version: artifact.version,
      pointerPath: currentPointerPath,
      activated: false,
      previousRuntimePath: previousSelectablePointer?.runtime_home ?? null,
      commitActivation() {
        if (rolledBack) return;
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
          payload_sha256: digest,
          managed_runtime_sha256: verifiedClosure.managedRuntimeDigest,
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
          previous: previousSelectablePointer,
          raw_text_included: false,
        });
        activationCommitted = true;
        activation.activated = true;
        if (backupCreated) {
          try {
            rmSync(backupHome, { recursive: true, force: true });
            backupCreated = false;
          } catch {
            // Backup cleanup is secondary once the selected pointer is committed.
          }
        }
      },
      rollbackActivation(error = new Error("App-managed Agent activation failed")) {
        if (rolledBack) return;
        rolledBack = true;
        let restoreError = null;
        try {
          if (activationCommitted) {
            if (previousSelectablePointer) {
              atomicWriteJson(currentPointerPath, previousSelectablePointer);
            } else {
              rmSync(currentPointerPath, { force: true });
            }
            if (previousSelectablePointer?.runtime_home !== runtimeHomeLabel) {
              rmSync(runtimeHome, { recursive: true, force: true });
            }
          } else if (backupCreated && existsSync(backupHome)) {
            rmSync(runtimeHome, { recursive: true, force: true });
            renameSync(backupHome, runtimeHome);
            backupCreated = false;
          } else {
            rmSync(runtimeHome, { recursive: true, force: true });
            if (previousSelectablePointer) {
              atomicWriteJson(currentPointerPath, previousSelectablePointer);
            }
            backupCreated = false;
          }
        } catch (rollbackError) {
          restoreError = rollbackError;
        }
        try {
          writeAppManagedRuntimeFailure({
            butlerData,
            version,
            artifactVersion: artifact.version,
            runtimeHomeLabel,
            payloadLabel,
            sourceRoot: root,
            payloadDigest: digest,
            managedRuntimeDigest: verifiedClosure.managedRuntimeDigest,
            preparedAt,
            error,
          });
        } catch {
          // Runtime restoration must not depend on diagnostic persistence.
        }
        if (restoreError) {
          throw restoreError;
        }
      },
    };
    return activation;
  } catch (error) {
    if (backupCreated && !existsSync(runtimeHome) && existsSync(backupHome)) {
      renameSync(backupHome, runtimeHome);
      backupCreated = false;
    }
    rmSync(stagingHome, { recursive: true, force: true });
    if (backupCreated) {
      rmSync(backupHome, { recursive: true, force: true });
    }
    const fallbackPointer = rollbackPointerAfterFailedRuntime(
      butlerData,
      previousPointer,
      runtimeHomeLabel,
    );
    if (fallbackPointer) {
      atomicWriteJson(currentPointerPath, fallbackPointer);
    }
    writeAppManagedRuntimeFailure({
      butlerData,
      version,
      artifactVersion: artifact.version,
      runtimeHomeLabel,
      payloadLabel,
      sourceRoot: root,
      payloadDigest: digest,
      managedRuntimeDigest: verifiedClosure.managedRuntimeDigest,
      preparedAt,
      error,
    });
    throw error;
  }
}

export function resolveAppManagedGatewayCommand({
  butlerData,
  env = process.env,
  resourcesPath = process.resourcesPath,
} = {}) {
  const resourceRoot = resolveBundledAgentResourceRoot({ env, resourcesPath });
  if (!resourceRoot) return null;
  const activation = prepareAppManagedAgentRuntime({
    butlerData,
    resourceRoot,
  });
  const runtime = resolveAppManagedRuntimeExecutable(activation.runtimeHome);
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
    rollbackActivation: activation.rollbackActivation,
  };
}

export function resolveAppManagedForegroundCommand({
  butlerData,
  env = process.env,
  resourcesPath = process.resourcesPath,
} = {}) {
  const resourceRoot = resolveBundledAgentResourceRoot({ env, resourcesPath });
  if (!resourceRoot) return null;
  const activation = prepareAppManagedAgentRuntime({ butlerData, resourceRoot });
  const runtime = resolveAppManagedRuntimeExecutable(activation.runtimeHome);
  const daemon = join(
    activation.runtimeHome,
    "packages",
    "butler-agent",
    "scripts",
    "native-service-daemon.ts",
  );
  if (!existsSync(daemon)) {
    activation.rollbackActivation(new Error("bundled Agent foreground host is missing"));
    throw new Error("bundled Agent foreground host is missing");
  }
  return {
    command: runtime,
    args: ["run", daemon],
    cwd: activation.runtimeHome,
    stdio: ["pipe", "inherit", "inherit"],
    appManaged: true,
    foregroundHost: true,
    bundledAgentVersion: activation.version,
    env: {
      BUTLER_HOME: activation.runtimeHome,
      BUTLER_APP_BUTLER_HOME: activation.runtimeHome,
      BUTLER_DATA: butlerData,
      BUTLER_BUN: runtime,
      BUTLER_APP_MANAGED_RUNTIME_POINTER: activation.pointerPath,
      BUTLER_APP_MANAGED_RUNTIME_HOME: activation.runtimeHome,
      BUTLER_APP_FOREGROUND_LEASE: "1",
    },
    commitActivation: activation.commitActivation,
    rollbackActivation: activation.rollbackActivation,
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
  assertManifestArtifactsUnsigned("bundled Agent release manifest", manifest);
  return {
    artifactName,
    version,
    sha256: safeString(artifact.sha256 ?? artifact.integrity?.digest),
  };
}

function verifyDependencyClosure(resourceRoot, artifact, artifactDigest) {
  const closurePath = join(resourceRoot, "dependency-closure.json");
  if (!existsSync(closurePath)) {
    throw new Error("dependency closure manifest is missing");
  }
  const updateManifest = readJson(join(resourceRoot, "agent-update-manifest.json"));
  assertManifestArtifactsUnsigned("bundled Agent update manifest", updateManifest);
  const closure = readJson(closurePath);
  if (
    closure?.schema !== "butler.app-bundled-agent-dependency-closure.v1" ||
    closure.product !== "butler-app" ||
    closure.gatewayProfile !== "electron"
  ) {
    throw new Error("dependency closure manifest is invalid");
  }
  if (Array.isArray(closure.hostToolsRequiredForFirstLaunch) &&
    closure.hostToolsRequiredForFirstLaunch.length > 0) {
    throw new Error("dependency closure requires host first-launch tools");
  }
  assertUnsignedIntegrity("dependency closure bundled Agent payload", closure.payload?.integrity);
  if (
    closure.payload?.artifactName !== artifact.artifactName ||
    closure.payload?.sha256 !== artifactDigest ||
    closure.payload?.integrity?.digestAlgorithm !== "sha256" ||
    closure.payload?.integrity?.digest !== artifactDigest
  ) {
    throw new Error("dependency closure bundled Agent payload digest mismatch");
  }

  const runtimeDigest = sha256Directory(join(resourceRoot, "runtime"));
  const releaseManifestDigest = sha256File(join(resourceRoot, "agent-release-manifest.json"));
  const updateManifestDigest = sha256File(join(resourceRoot, "agent-update-manifest.json"));
  const capabilityDigest = sha256File(join(resourceRoot, "background-service-capability.json"));
  const registrationDigest = sha256File(join(resourceRoot, "background-service-registration.json"));
  const installerPayloadDigest = sha256Directory(join(resourceRoot, "service-installer"));
  const registrationMetadataDigest = sha256Values([
    capabilityDigest,
    registrationDigest,
    installerPayloadDigest,
  ]);
  const expected = new Map([
    ["renderer-assets", artifactDigest],
    ["bootstrap-setup-ui", artifactDigest],
    ["bundled-agent-payload", artifactDigest],
    ["managed-runtime-payload", runtimeDigest],
    ["runtime-package-dependencies", sha256Values([artifactDigest, runtimeDigest])],
    ["release-manifests", sha256Values([releaseManifestDigest, updateManifestDigest])],
    ["background-service-registration-metadata", registrationMetadataDigest],
    [
      "bundled-payload-repair-source",
      sha256Values([
        artifactDigest,
        releaseManifestDigest,
        updateManifestDigest,
        runtimeDigest,
        registrationMetadataDigest,
      ]),
    ],
  ]);
  const dependencies = Array.isArray(closure.appOwnedDependencies)
    ? closure.appOwnedDependencies
    : [];
  for (const [id, digest] of expected) {
    const dependency = dependencies.find((item) => item?.id === id);
    if (!dependency) {
      throw new Error(`dependency closure missing ${id}`);
    }
    assertUnsignedIntegrity(`dependency closure ${id}`, dependency.integrity);
    if (dependency.integrity?.digestAlgorithm !== "sha256" ||
      dependency.integrity?.digest !== digest) {
      throw new Error(`dependency closure ${id} digest mismatch`);
    }
  }
  const repairSource = Array.isArray(closure.repairSources)
    ? closure.repairSources.find((item) => item?.id === "bundled-payload-repair-source")
    : null;
  assertUnsignedIntegrity("dependency closure repair source", repairSource?.integrity);
  if (
    repairSource?.verification !== "sha256" ||
    repairSource?.integrity?.digestAlgorithm !== "sha256" ||
    repairSource?.integrity?.digest !== expected.get("bundled-payload-repair-source")
  ) {
    throw new Error("dependency closure repair source digest mismatch");
  }
  return {
    managedRuntimeDigest: runtimeDigest,
  };
}

function assertManifestArtifactsUnsigned(label, manifest) {
  const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts : [];
  for (const artifact of artifacts) {
    assertUnsignedIntegrity(label, artifact);
    assertUnsignedIntegrity(label, artifact?.integrity);
  }
}

function assertUnsignedIntegrity(label, value) {
  if (value && typeof value === "object" && "signature" in value && value.signature != null) {
    throw new Error(
      `${label} signature verification is not implemented; signed artifacts must fail closed.`,
    );
  }
}

function rollbackPointerAfterFailedRuntime(butlerData, pointer, failedRuntimeHomeLabel) {
  if (
    pointer &&
    pointer.runtime_home !== failedRuntimeHomeLabel &&
    typeof pointer.runtime_home === "string" &&
    runtimeHomeReady(join(butlerData, pointer.runtime_home))
  ) {
    return pointer;
  }
  const previous = pointer?.previous;
  if (
    previous &&
    typeof previous.runtime_home === "string" &&
    runtimeHomeReady(join(butlerData, previous.runtime_home))
  ) {
    return previous;
  }
  return null;
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

function validAppManagedPointer(pointer) {
  return Boolean(
    pointer &&
      pointer.schema === APP_MANAGED_RUNTIME_POINTER_SCHEMA &&
      pointer.product === "butler-app" &&
      pointer.gateway_profile === "electron" &&
      typeof pointer.version === "string" &&
      typeof pointer.runtime_home === "string" &&
      pointer.runtime_home.trim(),
  );
}

function requireUpdateTransaction(butlerData, generation) {
  const transaction = readJsonIfPresent(appManagedAgentUpdateTransactionPath(butlerData));
  if (
    transaction?.schema !== APP_MANAGED_RUNTIME_UPDATE_TRANSACTION_SCHEMA ||
    transaction.generation !== generation
  ) {
    throw new Error("missing App-managed Agent runtime update transaction");
  }
  if (
    !validAppManagedPointer(transaction.previous_active_pointer) ||
    !validAppManagedPointer(transaction.active_pointer) ||
    !validAppManagedPointer(transaction.candidate_pointer)
  ) {
    throw new Error("invalid App-managed Agent runtime update transaction");
  }
  return transaction;
}

function writeRecoveredTransaction(butlerData, transaction) {
  atomicWriteJson(appManagedAgentUpdateTransactionPath(butlerData), transaction);
  return transaction;
}

function sameAppManagedPointer(left, right) {
  return Boolean(
    validAppManagedPointer(left) &&
      validAppManagedPointer(right) &&
      left.version === right.version &&
      left.runtime_home === right.runtime_home,
  );
}

function sanitizeUpdateProof(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ready: true,
      raw_text_included: false,
    };
  }
  const proof = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/token|secret|authorization|password|credential/iu.test(key)) {
      proof[key] = "[redacted]";
      continue;
    }
    if (/path|file|dir|home|root|cwd/iu.test(key) && typeof raw === "string") {
      proof[key] = redactDiagnosticsPath(raw);
      continue;
    }
    if (typeof raw === "string") proof[key] = redactDiagnosticsText(raw);
    else if (typeof raw === "number" || typeof raw === "boolean") proof[key] = raw;
  }
  proof.raw_text_included = false;
  return proof;
}

function runtimeHomeReady(runtimeHome, expected = null) {
  return runtimeHomeReadinessIssue(runtimeHome, expected) === null;
}

function runtimeHomeReadinessIssue(runtimeHome, expected = null) {
  if (
    !isFile(join(runtimeHome, "bin", "butler.js"))
  ) {
    return "missing bin/butler.js";
  }
  if (!isFile(join(runtimeHome, "packages", "butler-agent", "resources", "runtime", "bun-version"))) {
    return "missing managed runtime version";
  }
  if (!isFile(resolveAppManagedRuntimeExecutable(runtimeHome))) {
    return "missing managed runtime executable";
  }
  if (!expected) return null;
  const payloadPath = join(runtimeHome, "payloads", expected.artifactName);
  if (!isFile(payloadPath) || sha256File(payloadPath) !== expected.artifactDigest) {
    return "bundled Agent payload digest mismatch";
  }
  const runtimePayloadHome = appManagedRuntimePayloadHome(runtimeHome);
  if (sha256Directory(runtimePayloadHome) !== expected.managedRuntimeDigest) {
    return "managed runtime payload digest mismatch";
  }
  if (!archiveFilesInstalled(expected.artifactPath, runtimeHome)) {
    return "bundled Agent payload files mismatch";
  }
  return null;
}

function installManagedRuntimePayload(resourceRoot, runtimeHome) {
  const source = join(resourceRoot, "runtime");
  const bun = join(source, "bin", "bun");
  if (!existsSync(bun)) {
    throw new Error("managed runtime payload is missing bin/bun");
  }
  const target = appManagedRuntimePayloadHome(runtimeHome);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
  try {
    chmodSync(resolveAppManagedRuntimeExecutable(runtimeHome), 0o755);
  } catch {
    // Preserve copy success even on filesystems that do not support chmod.
  }
}

function appManagedRuntimePayloadHome(runtimeHome) {
  return join(runtimeHome, "packages", "butler-agent", "resources", "runtime");
}

function resolveAppManagedRuntimeExecutable(runtimeHome) {
  return join(appManagedRuntimePayloadHome(runtimeHome), "bin", "bun");
}

function archiveFilesInstalled(artifactPath, runtimeHome) {
  for (const entry of parseTarGz(artifactPath)) {
    if (entry.type !== "file") continue;
    if (isManagedRuntimeArchivePath(entry.name)) continue;
    const target = join(runtimeHome, entry.name);
    if (!isFile(target) || sha256File(target) !== sha256Bytes(entry.data)) {
      return false;
    }
  }
  return true;
}

function isManagedRuntimeArchivePath(entryName) {
  return (
    entryName === "packages/butler-agent/resources/runtime" ||
    entryName.startsWith("packages/butler-agent/resources/runtime/")
  );
}

function extractAgentArchive(artifactPath, runtimeHome) {
  let hasLauncher = false;
  for (const entry of parseTarGz(artifactPath)) {
    const normalized = normalizeArchiveEntry(entry.name);
    if (!normalized) continue;
    if (entry.type === "directory") {
      mkdirSync(join(runtimeHome, normalized), { recursive: true });
      continue;
    }
    const target = join(runtimeHome, normalized);
    mkdirSync(dirname(target), { recursive: true });
    if (entry.type === "symlink") {
      const linkTarget = safeSymlinkTarget(runtimeHome, target, entry.linkName);
      symlinkSync(linkTarget, target);
      continue;
    }
    writeFileSync(target, entry.data, { mode: entry.mode || 0o644 });
    if (normalized === "bin/butler.js") hasLauncher = true;
  }
  return { hasLauncher };
}

function parseTarGz(artifactPath) {
  try {
    return parseTarBuffer(
      gunzipSync(readFileSync(artifactPath), {
        maxOutputLength: maxAgentArchiveUncompressedBytes,
      }),
    );
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
  let nextLinkPath = null;
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
      if (typeFlag === "x" && typeof pax.linkpath === "string") {
        nextLinkPath = pax.linkpath;
      }
      continue;
    }

    const name = nextPath ?? tarHeaderPath(header);
    const linkName = nextLinkPath ?? trimNull(header.subarray(157, 257).toString("utf8"));
    nextPath = null;
    nextLinkPath = null;
    const normalized = normalizeArchiveEntry(name);
    if (!normalized) continue;
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error("bundled Agent artifact contains an unsafe path");
    }
    if (
      typeFlag !== "0" &&
      typeFlag !== "\0" &&
      typeFlag !== "" &&
      typeFlag !== "5" &&
      typeFlag !== "2"
    ) {
      throw new Error("bundled Agent artifact contains an unsafe entry type");
    }
    entries.push({
      name: normalized,
      type: typeFlag === "5" ? "directory" : typeFlag === "2" ? "symlink" : "file",
      linkName,
      mode: parseOctal(header.subarray(100, 108)),
      data,
    });
  }
  return entries;
}

function safeSymlinkTarget(root, target, linkName) {
  const linkTarget = String(linkName ?? "");
  if (!linkTarget || linkTarget.startsWith("/")) {
    throw new Error("bundled Agent artifact contains an unsafe symlink");
  }
  const resolvedRoot = `${resolve(root)}/`;
  const resolvedTarget = resolve(dirname(target), linkTarget);
  if (resolvedTarget !== resolve(root) && !resolvedTarget.startsWith(resolvedRoot)) {
    throw new Error("bundled Agent artifact contains an unsafe symlink");
  }
  return linkTarget;
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

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Directory(path) {
  const hash = createHash("sha256");
  for (const file of listFiles(path)) {
    const label = file.slice(path.length + 1).replace(/\\/g, "/");
    hash.update(label);
    hash.update("\0");
    hash.update(sha256File(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function listFiles(path) {
  const result = [];
  for (const entry of readdirSync(path).sort()) {
    const fullPath = join(path, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) result.push(...listFiles(fullPath));
    else if (stat.isFile()) result.push(fullPath);
  }
  return result;
}

function sha256Values(values) {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(value);
    hash.update("\0");
  }
  return hash.digest("hex");
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

function writeAppManagedRuntimeFailure({
  butlerData,
  version,
  artifactVersion,
  runtimeHomeLabel,
  payloadLabel,
  sourceRoot,
  payloadDigest,
  managedRuntimeDigest,
  preparedAt,
  error,
}) {
  atomicWriteJson(join(butlerData, "app", "runtime", "agent", "failures", `${version}.json`), {
    schema: APP_MANAGED_RUNTIME_SCHEMA,
    product: "butler-app",
    bundled_agent_product: "butler-agent",
    bundled_agent_version: artifactVersion,
    gateway_profile: "electron",
    runtime_home: runtimeHomeLabel,
    payload_path: payloadLabel,
    source_resource_path: redactDiagnosticsPath(sourceRoot),
    payload_format: "agent-archive",
    payload_sha256: payloadDigest,
    managed_runtime_sha256: managedRuntimeDigest,
    activation_policy: "versioned-app-managed-runtime",
    rollback_policy: "preserve-previous-app-managed-runtime",
    prepared_at: preparedAt,
    selected_at: null,
    activation_status: "rolled_back",
    rollback_reason: redactDiagnosticsText(
      error instanceof Error ? error.message : String(error),
    ),
    raw_text_included: false,
  });
}

function redactDiagnosticsText(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, "Bearer [redacted-token]")
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/gu, "[redacted-token]")
    .replace(/~[\\/][^"'\n\r\t,)]+/gu, "[redacted-path]")
    .replace(/[A-Za-z]:\\Users\\[^"'\n\r\t,)]+/gu, "[redacted-path]")
    .replace(/\\Users\\[^"'\n\r\t,)]+/gu, "[redacted-path]")
    .replace(/\/Users\/[^"'\n\r\t,)]+/gu, "[redacted-path]")
    .replace(/\/private\/[^"'\n\r\t,)]+/gu, "[redacted-path]")
    .replace(/(^|[=:\s'"(])\/(?!\/)[^ "'\n\r\t,)]+/gu, "$1[redacted-path]")
    .replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted-token]");
}

function redactDiagnosticsPath(value) {
  const text = String(value);
  const normalized = text.replaceAll("\\", "/");
  if (text.includes(".app/Contents/Resources")) return "[app-resource]";
  if (text.startsWith("app/")) return text;
  if (text.startsWith("runtime/")) return text;
  if (
    normalized.startsWith("~/") ||
    normalized.startsWith("/Users/") ||
    normalized.startsWith("/private/") ||
    /^[A-Za-z]:\/Users\//u.test(normalized)
  ) {
    return "[redacted-path]";
  }
  if (text.startsWith("/")) return "[redacted-path]";
  return redactDiagnosticsText(text);
}
