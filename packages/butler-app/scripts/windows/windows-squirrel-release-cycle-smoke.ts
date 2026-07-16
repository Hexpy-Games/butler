import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  createAppReleasePackage,
  verifyWindowsAuthenticodeFiles,
} from "../release/package-app-release.ts";
import {
  verifyWindowsInstallerPublisher,
} from "../../client/electron/windows-squirrel-lifecycle.mjs";
import { windowsValidationToken } from "./windows-validation-token.ts";
import {
  verifySha256,
  verifySignedWindowsPayload,
} from "./windows-release-verification.ts";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Squirrel release-cycle smoke requires Windows x64");
}
const validationToken = windowsValidationToken();
const prepareOnly = process.argv.includes("--prepare-only");
const releasePreparationAuthorized = prepareOnly &&
  process.env.BUTLER_WINDOWS_RELEASE_PREPARATION_TOKEN === "1";
if (!validationToken.accepted && !releasePreparationAuthorized) {
  throw new Error("Squirrel release-cycle smoke requires a standard-user or CI token");
}
const expectedSignerThumbprint = requireExpectedSignerThumbprint();

const root = process.cwd();
const currentVersion = readFileSync(join(root, "VERSION"), "utf8").trim();
const previousVersion = decrementPatch(currentVersion);
const electronPackagePath = join(
  root,
  "packages",
  "butler-app",
  "client",
  "electron",
  "package.json",
);
const rootPackagePath = join(root, "package.json");
const originalRootPackage = readFileSync(rootPackagePath);
const originalVersionFile = readFileSync(join(root, "VERSION"));
const originalElectronPackage = readFileSync(electronPackagePath);
const preparedReleaseRoot = process.env.BUTLER_WINDOWS_LIFECYCLE_RELEASE_ROOT
  ?.trim();
const validationRoot = preparedReleaseRoot
  ? resolve(preparedReleaseRoot)
  : join(homedir(), ".butler-release-validation", "squirrel-cycle");
const outPrevious = join(validationRoot, previousVersion);
const outCurrent = join(validationRoot, currentVersion);
const preparedReleaseManifestPath = join(validationRoot, "prepared-releases.json");
const isolatedRoot = join(tmpdir(), "Butler Squirrel E2E 한글");
const butlerData = join(isolatedRoot, "data");
const electronUserData = join(isolatedRoot, "electron-profile");
const evidenceTemplate = join(isolatedRoot, "events", "{event}.json");
const installRoot = join(
  process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
  "butler-app",
);
const ownershipMarker = join(installRoot, ".butler-windows-e2e-owned");
const startMenuShortcut = join(
  process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
  "Microsoft",
  "Windows",
  "Start Menu",
  "Programs",
  "Butler.lnk",
);
const previousPointerPath = join(
  butlerData,
  "app",
  "runtime",
  "agent",
  "current.json",
);
const startupFailurePath = join(
  butlerData,
  "app",
  "runtime",
  "foreground",
  "startup-failure.json",
);
const durableSentinel = join(butlerData, "user-preserved.txt");
const systemRoot = process.env.SystemRoot?.trim() ||
  process.env.SYSTEMROOT?.trim() || "C:\\Windows";
const powerShellExecutable = process.env.BUTLER_POWERSHELL?.trim() || join(
  systemRoot,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const taskkillExecutable = join(systemRoot, "System32", "taskkill.exe");
const launchedAppPids = new Set<number>();
const smokeEnv = {
  ...process.env,
  BUTLER_DATA: butlerData,
  BUTLER_APP_ELECTRON_USER_DATA_DIR: electronUserData,
  BUTLER_WINDOWS_SQUIRREL_EVIDENCE_PATH: evidenceTemplate,
  BUTLER_APP_SERVER_PORT: "18865",
  BUTLER_POWERSHELL: powerShellExecutable,
};

if (prepareOnly) {
  prepareLifecycleReleases();
  process.exit(0);
}

let installedBySmoke = false;
try {
  cleanupOwnedPriorInstall();
  if (!preparedReleaseRoot) {
    rmSync(validationRoot, { force: true, recursive: true });
  }
  rmSync(isolatedRoot, { force: true, recursive: true });
  mkdirSync(butlerData, { recursive: true });

  const prepared = loadPreparedLifecycleReleases();
  const previous = prepared?.previous ?? packageVersion(previousVersion, outPrevious);
  const current = prepared?.current ?? packageVersion(currentVersion, outCurrent);
  if (!prepared) restoreSourceVersions();
  const previousPackageVerification = verifyPackagedRelease(previous);
  const currentPackageVerification = verifyPackagedRelease(current);

  const previousSetup = requiredSetup(previous);
  const currentSetup = requiredSetup(current);
  runInstaller(previousSetup);
  installedBySmoke = true;
  mkdirSync(installRoot, { recursive: true });
  writeFileSync(ownershipMarker, "Butler Windows E2E only\n", "utf8");

  const previousApp = installedAppExecutable(previousVersion);
  await waitFor(() => existsSync(previousApp), "N-1 installed executable");
  await waitFor(() => evidence("install")?.normalInitializationReached === false,
    "install event early exit");
  await waitFor(() => existsSync(startMenuShortcut), "Start Menu shortcut");
  await ensureRuntimeReady(previousApp, previousVersion);
  const previousPointer = readFileSync(previousPointerPath);
  await stopInstalledProcessesAndWait("N-1 process cleanup");

  const installedPreviousSignature = verifyWindowsAuthenticodeFiles([previousApp])[0];
  const setupSignatures = verifyWindowsAuthenticodeFiles([previousSetup, currentSetup]);
  if (
    installedPreviousSignature?.signerThumbprint !== setupSignatures[0]?.signerThumbprint ||
    setupSignatures[0]?.signerThumbprint !== setupSignatures[1]?.signerThumbprint
  ) {
    throw new Error("Squirrel release-cycle publishers are inconsistent");
  }
  verifyWindowsInstallerPublisher({
    currentExecutable: previousApp,
    candidateInstaller: currentSetup,
    runPowerShell: (command, args, options) => spawnSync(command, args, {
      ...options,
      encoding: "utf8",
    }),
    env: smokeEnv,
  });

  writeFileSync(durableSentinel, "preserve-user-data\n", "utf8");
  runSquirrelUpdate(outCurrent);
  const currentApp = installedAppExecutable(currentVersion);
  await waitFor(() => existsSync(currentApp), "updated installed executable");
  await waitFor(() => evidence("updated")?.normalInitializationReached === false,
    "update event early exit");
  await stopInstalledProcessesAndWait("post-update process cleanup");

  writeFileSync(previousPointerPath, previousPointer);
  rmSync(join(
    butlerData,
    "app",
    "runtime",
    "agent",
    "versions",
    currentVersion,
  ), { force: true, recursive: true });
  const bundledRoot = join(
    dirname(currentApp),
    "resources",
    "bundled-agent",
  );
  const releaseManifest = JSON.parse(readFileSync(
    join(bundledRoot, "agent-release-manifest.json"),
    "utf8",
  ));
  const agentArtifact = join(bundledRoot, releaseManifest.artifacts?.[0]?.artifactName ?? "");
  if (!existsSync(agentArtifact)) {
    throw new Error("Installed bundled Agent artifact is missing");
  }
  const originalArtifact = readFileSync(agentArtifact);
  const corruptArtifact = Buffer.from(originalArtifact);
  corruptArtifact[Math.min(32, corruptArtifact.length - 1)] ^= 0xff;
  writeFileSync(agentArtifact, corruptArtifact);
  try {
    launchInstalledApp(currentApp);
    await waitFor(() => existsSync(startupFailurePath), "failed-readiness evidence");
    await waitFor(() => pointerVersion() === previousVersion, "runtime rollback pointer");
  } finally {
    writeFileSync(agentArtifact, originalArtifact);
    await stopInstalledProcessesAndWait("failed candidate cleanup");
  }

  await ensureRuntimeReady(currentApp, currentVersion);
  await stopInstalledProcessesAndWait("repair process cleanup");
  await ensureRuntimeReady(currentApp, currentVersion);
  await stopInstalledProcessesAndWait("idempotent repair cleanup");

  mkdirSync(join(butlerData, "updates", "artifacts"), { recursive: true });
  writeFileSync(join(butlerData, "updates", "artifacts", "ephemeral"), "remove\n");
  runOwnedAppUninstaller();
  await waitFor(() => evidence("uninstall")?.operationalStateRemoved === true,
    "uninstall event cleanup evidence");
  removeOwnedInstallRoot();
  installedBySmoke = false;
  await waitFor(() => !existsSync(installRoot), "Squirrel uninstall cleanup");
  if (existsSync(join(butlerData, "app", "runtime")) ||
    existsSync(join(butlerData, "updates"))) {
    throw new Error("Uninstall preserved App operational state");
  }
  if (readFileSync(durableSentinel, "utf8").trim() !== "preserve-user-data") {
    throw new Error("Uninstall removed durable user data");
  }
  if (existsSync(startMenuShortcut)) {
    throw new Error("Uninstall left the Butler Start Menu shortcut");
  }
  await stopInstalledProcessesAndWait("uninstall process cleanup");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    platform: "win32-x64",
    standardUser: validationToken.standardUser,
    ciElevatedToken: validationToken.ciElevatedToken,
    previousVersion,
    currentVersion,
    signedInstall: true,
    checksumsVerified: true,
    previousSignedPeCount: previousPackageVerification.peCount,
    currentSignedPeCount: currentPackageVerification.peCount,
    squirrelEventsBeforeNormalInitialization: true,
    update: true,
    failedReadinessRollback: true,
    repairIdempotent: true,
    uninstallOperationalStateRemoved: true,
    uninstallUserDataPreserved: true,
    postRunProcessCount: installedProcessCount(),
    evidenceDigest: evidenceDigest(),
    rawTextIncluded: false,
  })}\n`);
} finally {
  if (!preparedReleaseRoot) restoreSourceVersions();
  try {
    await stopInstalledProcessesAndWait("final teardown", 20_000);
  } catch {
    // Preserve the primary validation result while still attempting uninstall.
  }
  if (installedBySmoke || existsSync(ownershipMarker)) {
    try {
      uninstallOwnedApp();
    } catch {
      // Preserve the primary validation result while still attempting teardown.
    }
  }
}

function prepareLifecycleReleases(): void {
  if (!preparedReleaseRoot) {
    throw new Error(
      "Squirrel release preparation requires BUTLER_WINDOWS_LIFECYCLE_RELEASE_ROOT",
    );
  }
  try {
    rmSync(validationRoot, { force: true, recursive: true });
    mkdirSync(validationRoot, { recursive: true });
    const previous = packageVersion(previousVersion, outPrevious);
    const current = packageVersion(currentVersion, outCurrent);
    restoreSourceVersions();
    const previousVerification = verifyPackagedRelease(previous);
    const currentVerification = verifyPackagedRelease(current);
    writeFileSync(preparedReleaseManifestPath, `${JSON.stringify({
      schema: "butler.windows.prepared-squirrel-releases.v1",
      previousVersion,
      currentVersion,
      previous,
      current,
    }, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      preparedOnly: true,
      previousVersion,
      currentVersion,
      previousSignedPeCount: previousVerification.peCount,
      currentSignedPeCount: currentVerification.peCount,
      rawTextIncluded: false,
    })}\n`);
  } finally {
    restoreSourceVersions();
  }
}

function loadPreparedLifecycleReleases(): {
  previous: ReturnType<typeof createAppReleasePackage>;
  current: ReturnType<typeof createAppReleasePackage>;
} | null {
  if (!preparedReleaseRoot) return null;
  if (!existsSync(preparedReleaseManifestPath)) {
    throw new Error("Prepared Windows Squirrel releases are missing");
  }
  const manifest = JSON.parse(readFileSync(
    preparedReleaseManifestPath,
    "utf8",
  ));
  if (
    manifest?.schema !== "butler.windows.prepared-squirrel-releases.v1" ||
    manifest.previousVersion !== previousVersion ||
    manifest.currentVersion !== currentVersion ||
    !manifest.previous ||
    !manifest.current
  ) {
    throw new Error("Prepared Windows Squirrel release manifest is invalid");
  }
  return {
    previous: manifest.previous,
    current: manifest.current,
  };
}

function packageVersion(version: string, outDir: string) {
  writeSourceVersions(version);
  rmSync(outDir, { force: true, recursive: true });
  return createAppReleasePackage({
    root,
    outDir,
    platforms: ["win32-x64"],
    artifactBaseUrl: "https://updates.invalid/butler/windows",
  });
}

function verifyPackagedRelease(
  result: ReturnType<typeof createAppReleasePackage>,
): { peCount: number } {
  const artifact = requiredWindowsArtifact(result);
  if (!artifact.updaterArtifactPath || !artifact.updaterSha256Path ||
    !artifact.updaterIndexPath || !artifact.updaterIndexSha256Path) {
    throw new Error("Windows Squirrel release output is incomplete");
  }
  verifySha256(artifact.artifactPath, artifact.sha256Path);
  verifySha256(artifact.updaterArtifactPath, artifact.updaterSha256Path);
  verifySha256(artifact.updaterIndexPath, artifact.updaterIndexSha256Path);
  return verifySignedWindowsPayload({
    expectedSignerThumbprint,
    packagePath: artifact.updaterArtifactPath,
    setupPath: artifact.artifactPath,
  });
}

function writeSourceVersions(version: string): void {
  writeFileSync(join(root, "VERSION"), `${version}\n`, "utf8");
  const rootPkg = JSON.parse(originalRootPackage.toString("utf8"));
  rootPkg.version = version;
  writeFileSync(rootPackagePath, `${JSON.stringify(rootPkg, null, 2)}\n`, "utf8");
  const pkg = JSON.parse(originalElectronPackage.toString("utf8"));
  pkg.version = version;
  writeFileSync(electronPackagePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

function restoreSourceVersions(): void {
  writeFileSync(join(root, "VERSION"), originalVersionFile);
  writeFileSync(rootPackagePath, originalRootPackage);
  writeFileSync(electronPackagePath, originalElectronPackage);
}

function requiredSetup(result: ReturnType<typeof createAppReleasePackage>): string {
  const artifact = requiredWindowsArtifact(result);
  if (!existsSync(artifact.artifactPath)) {
    throw new Error("Windows Setup.exe is missing from release package result");
  }
  return artifact.artifactPath;
}

function requiredWindowsArtifact(
  result: ReturnType<typeof createAppReleasePackage>,
) {
  const artifact = result.artifacts.find((item) => item.platform === "win32-x64");
  if (!artifact) throw new Error("Windows release package result is missing");
  return artifact;
}

function requireExpectedSignerThumbprint(): string {
  const value = process.env.BUTLER_WINDOWS_SIGN_CERTIFICATE_SHA1
    ?.trim()
    .toUpperCase();
  if (!value || !/^[A-F0-9]{40}$/u.test(value)) {
    throw new Error("Squirrel release-cycle smoke requires a signing thumbprint");
  }
  return value;
}

function runInstaller(setupPath: string): void {
  const result = spawnSync(setupPath, ["--silent"], {
    encoding: "utf8",
    env: smokeEnv,
    shell: false,
    timeout: 180_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Squirrel installer failed: ${boundedCode(result.status)}`);
  }
}

function runSquirrelUpdate(releaseDirectory: string): void {
  const updateExecutable = join(installRoot, "Update.exe");
  if (!existsSync(updateExecutable)) {
    throw new Error("Installed Squirrel updater is missing");
  }
  const result = spawnSync(
    updateExecutable,
    ["--update", releaseDirectory, "--silent"],
    {
      encoding: "utf8",
      env: smokeEnv,
      shell: false,
      timeout: 180_000,
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    throw new Error(`Squirrel update failed: ${boundedCode(result.status)}`);
  }
}

function installedAppExecutable(version: string): string {
  return join(installRoot, `app-${version}`, "Butler.exe");
}

async function ensureRuntimeReady(executable: string, version: string): Promise<void> {
  if (pointerVersion() !== version) launchInstalledApp(executable);
  await waitFor(() => pointerVersion() === version, `runtime readiness ${version}`);
}

function launchInstalledApp(executable: string): void {
  const child = spawn(executable, [], {
    detached: false,
    env: smokeEnv,
    shell: false,
    stdio: "ignore",
    windowsHide: false,
  });
  if (!child.pid) throw new Error("Installed Butler launch did not return a PID");
  launchedAppPids.add(child.pid);
  child.unref();
}

function pointerVersion(): string | null {
  try {
    const pointer = JSON.parse(readFileSync(previousPointerPath, "utf8"));
    return typeof pointer?.version === "string" ? pointer.version : null;
  } catch {
    return null;
  }
}

function evidence(event: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(
      evidenceTemplate.replace("{event}", event),
      "utf8",
    ));
  } catch {
    return null;
  }
}

function evidenceDigest(): string {
  const values = ["install", "updated", "obsolete", "uninstall"]
    .map((event) => evidence(event))
    .filter(Boolean);
  return createHash("sha256")
    .update(JSON.stringify(values))
    .digest("hex")
    .slice(0, 16);
}

interface InstalledProcessSummary {
  pid: number;
  name: string;
}

async function stopInstalledProcessesAndWait(
  label: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let remaining = installedProcesses();
  while (remaining.length > 0 && Date.now() < deadline) {
    for (const item of remaining) {
      spawnSync(taskkillExecutable, [
        "/PID",
        String(item.pid),
        "/T",
        "/F",
      ], {
        encoding: "utf8",
        shell: false,
        timeout: 20_000,
        windowsHide: true,
      });
    }
    await Bun.sleep(250);
    remaining = installedProcesses();
  }
  if (remaining.length > 0) {
    throw new Error(
      `Squirrel release-cycle timeout: ${label}; remaining=${JSON.stringify(remaining)}`,
    );
  }
}

function installedProcesses(): InstalledProcessSummary[] {
  return [...launchedAppPids]
    .filter((pid) => processAlive(pid))
    .map((pid) => ({ pid, name: "Butler.exe" }));
}

function installedProcessCount(): number {
  return installedProcesses().length;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function uninstallOwnedApp(): void {
  runOwnedAppUninstaller();
  removeOwnedInstallRoot();
}

function runOwnedAppUninstaller(): void {
  const updateExecutable = join(installRoot, "Update.exe");
  if (existsSync(updateExecutable)) {
    const result = spawnSync(updateExecutable, ["--uninstall", "-s"], {
      encoding: "utf8",
      env: smokeEnv,
      shell: false,
      timeout: 120_000,
      windowsHide: true,
    });
    if (result.status !== 0) {
      throw new Error(`Squirrel uninstall failed: ${boundedCode(result.status)}`);
    }
  }
}

function removeOwnedInstallRoot(): void {
  rmSync(installRoot, { force: true, maxRetries: 4, recursive: true, retryDelay: 250 });
}

function cleanupOwnedPriorInstall(): void {
  if (!existsSync(installRoot)) return;
  if (!existsSync(ownershipMarker)) {
    throw new Error("A non-test Butler Squirrel installation already exists");
  }
  uninstallOwnedApp();
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(250);
  }
  throw new Error(`Squirrel release-cycle timeout: ${label}`);
}

function decrementPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) throw new Error("Butler version must be semantic x.y.z");
  const patch = Number(match[3]);
  if (!Number.isInteger(patch) || patch <= 0) {
    throw new Error("Butler version requires a positive patch for N-1 validation");
  }
  return `${match[1]}.${match[2]}.${patch - 1}`;
}

function boundedCode(value: number | null): string {
  return Number.isInteger(value) ? String(value) : "unknown";
}
