import { expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const root = process.cwd();
const currentVersion = String(
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "",
);
const currentReleaseTag = `v${currentVersion}`;

function readRepoFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

test("version tag release workflow publishes Butler Agent artifact with packaged app client", () => {
  const workflowPath = join(root, ".github", "workflows", "release.yml");
  expect(existsSync(workflowPath)).toBe(true);
  const workflow = readFileSync(workflowPath, "utf8");

  const gateIndex = workflow.indexOf("bun run release:agent:gate");
  const packageIndex = workflow.indexOf("bun run release:agent:package");
  const verifyIndex = workflow.indexOf(
    "Smoke Butler Agent release artifact",
  );
  const publishIndex = workflow.indexOf("Publish GitHub Release");

  expect(workflow).toContain("tags:\n      - \"v*\"");
  expect(workflow).toContain("contents: write");
  expect(workflow).toContain("Build and publish Butler Agent artifact");
  expect(workflow).toContain("Run Butler Agent release gate");
  expect(workflow).toContain("Package Butler Agent release");
  expect(workflow).toContain('notes_args=(--notes "Butler Agent release $tag")');
  expect(workflow).toContain("Expected 4 Butler Agent release files");
  expect(workflow).toContain("bun install --frozen-lockfile");
  expect(workflow).toContain("npm --prefix packages/butler-app/client/ui ci");
  expect(gateIndex).toBeGreaterThan(-1);
  expect(packageIndex).toBeGreaterThan(gateIndex);
  expect(verifyIndex).toBeGreaterThan(packageIndex);
  expect(publishIndex).toBeGreaterThan(verifyIndex);
  const agentSmoke = readRepoFile("deploy/agent/smoke.ts");
  expect(agentSmoke).toContain(
    "./packages/butler-agent/resources/app-client/dist/index.html",
  );
  expect(agentSmoke).toContain(
    "./packages/butler-agent/resources/app-client/dist/assets/",
  );
  expect(workflow).toContain(
    "dist/release/agent/butler-agent-*-all.tar.gz",
  );
  expect(workflow).toContain("bun run release:agent:smoke -- --out dist/release/agent");
  expect(workflow).toContain("--artifact-base-url");
  expect(workflow).toContain(
    "https://github.com/${GITHUB_REPOSITORY}/releases/download/${GITHUB_REF_NAME}",
  );
  expect(workflow).toContain(
    "dist/release/agent/butler-agent-*-all.tar.gz.sha256",
  );
  expect(workflow).toContain(
    "dist/release/agent/agent-release-manifest.json",
  );
  expect(workflow).toContain("dist/release/agent/agent-update-manifest.json");
  expect(workflow).toContain('notes_file=".github/releases/${tag}.md"');
  expect(workflow).toContain('notes_args=(--notes-file "$notes_file")');
  expect(workflow).toContain(
    'gh release edit "$tag" --title "$tag" "${notes_args[@]}"',
  );
  expect(workflow).toContain(
    'gh release upload "$tag" "${files[@]}" --clobber',
  );
  expect(workflow).toContain('gh release create "$tag" "${files[@]}"');
  expect(workflow).not.toContain("./install.sh");
  expect(workflow).not.toContain("packages/butler-app/client/ui/dist");
});

test("version tag release workflow publishes signed app artifacts", () => {
  const workflowPath = join(root, ".github", "workflows", "release.yml");
  expect(existsSync(workflowPath)).toBe(true);
  const workflow = readFileSync(workflowPath, "utf8");

  const serviceJobIndex = workflow.indexOf("agent-artifact:");
  const appJobIndex = workflow.indexOf("app-artifact:");
  const baselineIndex = workflow.indexOf("Fetch previous app release manifest");
  const appGateIndex = workflow.indexOf("bun run release:app:gate");
  const packageIndex = workflow.indexOf("bun run release:app:package");
  const linuxPrepIndex = workflow.indexOf("Prepare Linux app-managed Bun payload");
  const verifyIndex = workflow.indexOf("Verify packaged app artifacts");
  const publishIndex = workflow.indexOf("Publish app GitHub Release files");

  expect(appJobIndex).toBeGreaterThan(serviceJobIndex);
  expect(workflow).toContain("runs-on: macos-latest");
  expect(workflow).toContain("needs: agent-artifact");
  expect(workflow).toContain("npm --prefix packages/butler-app/client/electron ci");
  expect(workflow).toContain("Fetch previous app release manifest");
  expect(workflow).toContain("gh release download \"$previous_tag\"");
  expect(workflow).toContain("app-release-manifest.json");
  expect(workflow).toContain("BUTLER_APP_PREVIOUS_RELEASE_MANIFEST");
  expect(workflow).toContain("bun run release:app:gate");
  expect(workflow).toContain("Prepare Linux app-managed Bun payload");
  expect(workflow).toContain("bun-linux-x64.zip");
  expect(workflow).toContain("bun-linux-aarch64.zip");
  expect(workflow).toContain("BUTLER_APP_MANAGED_BUN_LINUX_X64=$linux_bun");
  expect(workflow).toContain("BUTLER_APP_MANAGED_BUN_LINUX_ARM64=$arm_linux_bun");
  expect(workflow).toContain("ELF 64-bit.*x86-64");
  expect(workflow).toContain("brew install dpkg");
  expect(workflow).toContain("command -v dpkg-deb");
  expect(baselineIndex).toBeGreaterThan(appJobIndex);
  expect(appGateIndex).toBeGreaterThan(baselineIndex);
  expect(linuxPrepIndex).toBeGreaterThan(appJobIndex);
  expect(linuxPrepIndex).toBeGreaterThan(appGateIndex);
  expect(packageIndex).toBeGreaterThan(linuxPrepIndex);
  expect(packageIndex).toBeGreaterThan(appJobIndex);
  expect(workflow).toContain("--artifact-base-url");
  expect(verifyIndex).toBeGreaterThan(packageIndex);
  expect(workflow).toContain("bun run release:app:smoke -- --out dist/release/app");
  expect(workflow).not.toContain("codesign --verify --deep --strict --verbose=4");
  expect(workflow).not.toContain('grep -F "Butler-linux-x64/Butler"');
  expect(workflow).toContain("dist/release/app/butler-app-*-darwin-arm64.pkg");
  expect(workflow).toContain("dist/release/app/butler-app-*-darwin-arm64.pkg.sha256");
  expect(workflow).toContain("dist/release/app/butler-app-*-linux-x64.deb");
  expect(workflow).toContain("dist/release/app/butler-app-*-linux-x64.deb.sha256");
  expect(workflow).toContain("dist/release/app/butler-app-*-linux-arm64.deb");
  expect(workflow).toContain("dist/release/app/butler-app-*-linux-arm64.deb.sha256");
  expect(workflow).toContain("dist/release/app/app-release-manifest.json");
  expect(workflow).toContain("dist/release/app/app-update-manifest.json");
  expect(workflow).toContain("Expected 8 app release files");
  expect(publishIndex).toBeGreaterThan(verifyIndex);
  expect(workflow).toContain('gh release upload "$tag" "${files[@]}" --clobber');
});

test("version tag release workflow publishes Linux app service installer packages", () => {
  const workflowPath = join(root, ".github", "workflows", "release.yml");
  expect(existsSync(workflowPath)).toBe(true);
  const workflow = readFileSync(workflowPath, "utf8");

  const appJobIndex = workflow.indexOf("app-artifact:");
  const installerJobIndex = workflow.indexOf("app-linux-service-installers:");
  const downloadIndex = workflow.indexOf("gh release download \"$tag\"");
  const buildIndex = workflow.indexOf("linux-service-installer-package.ts");
  const publishIndex = workflow.indexOf("Publish Linux app service installer packages");

  expect(installerJobIndex).toBeGreaterThan(appJobIndex);
  expect(workflow).toContain("Build and publish Linux app service installers");
  expect(workflow).toContain("runs-on: ubuntu-latest");
  expect(workflow).toContain("needs: app-artifact");
  expect(workflow).toContain(
    "sudo apt-get install -y fakeroot libarchive-tools pacman-package-manager rpm zstd",
  );
  expect(workflow).toContain("sudo mkdir -p /var/lib/pacman/local");
  expect(workflow).toContain("sudo chmod -R a+rwx /var/lib/pacman");
  expect(workflow).toContain("command -v dpkg-deb");
  expect(workflow).toContain("command -v makepkg");
  expect(workflow).toContain("command -v rpmbuild");
  expect(workflow).toContain("command -v bsdtar");
  expect(workflow).toContain("--pattern 'butler-app-*-linux-x64.deb'");
  expect(workflow).toContain("--pattern 'butler-app-*-linux-x64.deb.sha256'");
  expect(workflow).toContain("sha256sum -c");
  expect(workflow).toContain("Expected one Linux App deb and checksum");
  expect(workflow).toContain("dpkg-deb -x");
  expect(workflow).toContain("opt/butler/Butler-linux-x64/resources/bundled-agent");
  expect(workflow).toContain("--build");
  expect(downloadIndex).toBeGreaterThan(installerJobIndex);
  expect(buildIndex).toBeGreaterThan(downloadIndex);
  expect(publishIndex).toBeGreaterThan(buildIndex);
  expect(workflow).toContain("dist/release/app/butler-app-service_*_amd64.deb");
  expect(workflow).toContain("dist/release/app/butler-app-service_*_amd64.deb.sha256");
  expect(workflow).toContain("dist/release/app/butler-app-service-*-1-x86_64.pkg.tar.zst");
  expect(workflow).toContain("dist/release/app/butler-app-service-*-1-x86_64.pkg.tar.zst.sha256");
  expect(workflow).toContain("dist/release/app/butler-app-service-*-1.x86_64.rpm");
  expect(workflow).toContain("dist/release/app/butler-app-service-*-1.x86_64.rpm.sha256");
  expect(workflow).toContain("Expected 6 Linux app service installer files");
});

test("version tag release workflow publishes Arch app artifact", () => {
  const workflowPath = join(root, ".github", "workflows", "release.yml");
  expect(existsSync(workflowPath)).toBe(true);
  const workflow = readFileSync(workflowPath, "utf8");

  const agentJobIndex = workflow.indexOf("agent-artifact:");
  const archJobIndex = workflow.indexOf("app-arch-artifact:");
  const packageIndex = workflow.indexOf("Package Arch app release");
  const verifyIndex = workflow.indexOf("Verify Arch app artifact");
  const publishIndex = workflow.indexOf("Publish Arch app artifact");

  expect(archJobIndex).toBeGreaterThan(agentJobIndex);
  expect(workflow).toContain("Build and publish Arch app artifact");
  expect(workflow).toContain("image: archlinux:base-devel");
  expect(workflow).toContain("pacman -S --needed --noconfirm bun curl file git github-cli nodejs npm openssh zstd");
  expect(workflow).toContain("mkdir -p /tmp/butler-bun-tmp");
  expect(workflow).toContain("mkdir -p /home/builder/.bun");
  expect(workflow).toContain("chown -R builder:builder /tmp/butler-bun-tmp /home/builder/.bun");
  expect(workflow).toContain("export HOME=/home/builder");
  expect(workflow).toContain("export BUN_INSTALL=/home/builder/.bun");
  expect(workflow).toContain("export BUN_TMPDIR=/tmp/butler-bun-tmp");
  expect(workflow).toContain("export TMPDIR=/tmp/butler-bun-tmp");
  expect(workflow).toContain("--linux-package-format=pacman");
  expect(workflow).toContain("dist/release/app-arch/butler-app-*-1-x86_64.pkg.tar.zst");
  expect(workflow).toContain("dist/release/app-arch/butler-app-*-1-x86_64.pkg.tar.zst.sha256");
  expect(workflow).toContain("pacman -Qip");
  expect(workflow).toContain("/usr/bin/butler-app$");
  expect(workflow).toContain("/usr/lib/systemd/user/butler.service$");
  expect(workflow).toContain("Expected 2 Arch app release files");
  expect(packageIndex).toBeGreaterThan(archJobIndex);
  expect(verifyIndex).toBeGreaterThan(packageIndex);
  expect(publishIndex).toBeGreaterThan(verifyIndex);
});

test("README directs default installs to Butler App and advanced installs to Agent artifacts", () => {
  const readme = readRepoFile("README.md");
  const quickStartStart = readme.indexOf("## Quick Start");
  const advancedAgentStart = readme.indexOf("## Advanced: Butler Agent");
  const howButlerWorksStart = readme.indexOf("## How Butler Works");
  const developmentStart = readme.indexOf("## Development");

  expect(quickStartStart).toBeGreaterThan(-1);
  expect(advancedAgentStart).toBeGreaterThan(quickStartStart);
  expect(howButlerWorksStart).toBeGreaterThan(advancedAgentStart);
  expect(developmentStart).toBeGreaterThan(howButlerWorksStart);

  const quickStart = readme.slice(quickStartStart, advancedAgentStart);
  const advancedAgent = readme.slice(advancedAgentStart, howButlerWorksStart);
  const normalizedQuickStart = normalizeWhitespace(quickStart);
  const development = readme.slice(developmentStart);

  expect(quickStart).toContain("GitHub Release");
  expect(quickStart).toContain(`butler-app-${currentVersion}-darwin-arm64.pkg`);
  expect(quickStart).toContain(`butler-app-${currentVersion}-linux-x64.deb`);
  expect(quickStart).toContain(`butler-app-${currentVersion}-linux-arm64.deb`);
  expect(quickStart).toContain(`butler-app-${currentVersion}-1-x86_64.pkg.tar.zst`);
  expect(normalizedQuickStart).toContain("Butler Agent is included in the app");
  expect(quickStart).toContain("Butler Agent를 준비합니다");
  expect(quickStart).not.toContain("butler-agent-*-all.tar.gz");
  expect(quickStart).not.toContain("./install.sh");
  expect(advancedAgent).toContain("butler-agent-*-all.tar.gz");
  expect(advancedAgent).toContain("./install.sh");
  expect(quickStart).not.toContain("git clone");
  expect(quickStart).not.toContain("bun install");
  expect(development).toContain(
    "git clone https://github.com/Hexpy-Games/butler.git ~/butler",
  );
  expect(development).toContain("bun install");
});

test("manual first-run test environment launches isolated Electron state", () => {
  const packageJson = JSON.parse(readRepoFile("package.json")) as {
    scripts?: Record<string, string>;
  };
  const script = readRepoFile("packages/butler-app/scripts/app-first-run-test-env.ts");

  expect(packageJson.scripts?.["app:first-run:test-env"]).toContain(
    "packages/butler-app/scripts/app-first-run-test-env.ts",
  );
  expect(packageJson.scripts?.["app:first-run:test-env"]).toContain("exec ");
  expect(packageJson.scripts?.["app:first-run:test-env"]).toContain(
    "packages/butler-app/client/ui run build",
  );
  expect(packageJson.scripts?.["app:first-run:service-test-env"]).toContain(
    "packages/butler-app/scripts/app-first-run-test-env.ts --native-service",
  );
  expect(script).toContain("BUTLER_DATA: dataDir");
  expect(script).toContain("BUTLER_HOME: root");
  expect(script).toContain("BUTLER_APP_SERVER_PORT: String(serverPort)");
  expect(script).toContain("BUTLER_APP_FORCE_NATIVE_SERVICE_BRIDGE");
  expect(script).toContain("BUTLER_APP_ALLOW_NATIVE_SERVICE_TEST_ENV");
  expect(script).toContain("BUTLER_APP_SERVICE_LABEL: serviceLabel");
  expect(script).toContain("BUTLER_APP_SYSTEMD_UNIT: systemdUnit");
  expect(script).toContain("BUTLER_APP_BUNDLED_AGENT_DIR");
  expect(script).toContain("prepareBundledAgentResource");
  expect(script).toContain("cleanupNativeService({ serviceLabel, systemdUnit })");
  expect(script).toContain("Refusing to use the production LaunchAgent label");
  expect(script).toContain("Refusing to use the production systemd unit");
  expect(script).toContain("Refusing to use the production app-server port");
  expect(script).toContain("--user-data-dir=${electronProfileDir}");
  expect(script).toContain("baseEnvAllowlist");
  expect(script).toContain("delete env.BUTLER_APP_SERVER_URL");
  expect(script).toContain("delete env.BUTLER_APP_SERVER_BRIDGE");
  expect(script).toContain("Refusing to use the real ~/.butler directory");
  expect(script).toContain("Refusing to use the normal Butler Electron profile");
  expect(script).toContain("assertPortAvailable(serverPort)");
  expect(script).toContain("cleanupOwnedPort(serverPort, ownedListenerPids ?? new Set<number>())");
  expect(script).toContain("not proof that the first-run wizard is implemented");
  expect(script).toContain("Electron profile:");
  expect(script).toContain("Quit Butler from the app/tray, or press Ctrl-C here to stop.");
});

test("manual app install test environment installs an isolated test pkg", () => {
  const packageJson = JSON.parse(readRepoFile("package.json")) as {
    scripts?: Record<string, string>;
  };
  const script = readRepoFile("packages/butler-app/scripts/app-install-test-env.ts");
  const distributionSpec = readRepoFile(
    "packages/butler-app/specs/background-service-distribution.md",
  );

  expect(packageJson.scripts?.["app:install:test-env"]).toContain(
    "packages/butler-app/scripts/app-install-test-env.ts",
  );
  expect(packageJson.scripts?.["app:install:test-env"]).toContain("exec ");
  expect(packageJson.scripts?.["app:install:test-env"]).toContain(
    "packages/butler-app/client/ui run build",
  );
  expect(script).toContain("Butler Install Tests");
  expect(script).toContain("installer");
  expect(script).toContain("-target");
  expect(script).toContain("CurrentUserHomeDirectory");
  expect(script).toContain("--validate-only");
  expect(script).toContain("isInsideRealPath");
  expect(script).toContain("Butler Install Test ${serviceSafeName}");
  expect(script).toContain("com.hexpy.butler.test.install");
  expect(script).toContain("BUTLER_DATA: dataDir");
  expect(script).toContain("BUTLER_APP_FORCE_NATIVE_SERVICE_BRIDGE");
  expect(script).toContain("BUTLER_APP_ALLOW_NATIVE_SERVICE_TEST_ENV");
  expect(script).toContain("BUTLER_APP_SERVICE_LABEL: serviceLabel");
  expect(script).toContain("BUTLER_APP_SYSTEMD_UNIT: systemdUnit");
  expect(script).toContain("BUTLER_APP_ELECTRON_USER_DATA_DIR: electronProfileDir");
  expect(script).toContain("Refusing to use the production LaunchAgent label");
  expect(script).toContain("Refusing to use the production systemd unit");
  expect(script).toContain("Refusing to use the production app-server port");
  expect(script).toContain("Refusing to use the real ~/.butler directory");
  expect(script).toContain("Refusing to use the normal Butler Electron profile");
  expect(script).toContain("cleanupNativeService({ serviceLabel, systemdUnit })");
  expect(script).toContain("rmSync(installedRoot, { recursive: true, force: true })");
  expect(script).toContain("rmSync(packageWorkDir, { recursive: true, force: true })");
  expect(script).toContain("--user-data-dir=${electronProfileDir}");
  expect(distributionSpec).toContain("Manual installer testing must not install the production App package");
  expect(distributionSpec).toContain("Cleanup must remove the");
  expect(distributionSpec).toContain("isolated Electron profile instead of falling back");
});

test("manual app install test environment validates isolation guards", () => {
  const ok = spawnSync(
    "bun",
    [
      "run",
      "packages/butler-app/scripts/app-install-test-env.ts",
      "--validate-only",
      "--profile",
      "unit-validate",
    ],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  expect(ok.status).toBe(0);
  expect(ok.stdout).toContain("validation passed");

  const productionData = spawnSync(
    "bun",
    [
      "run",
      "packages/butler-app/scripts/app-install-test-env.ts",
      "--validate-only",
      "--data",
      join(process.env.HOME ?? "", ".butler"),
    ],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  expect(productionData.status).not.toBe(0);
  expect(`${productionData.stdout}\n${productionData.stderr}`).toContain(
    "Refusing to use the real ~/.butler directory",
  );
});

test("current release notes describe the GitHub release changelog", () => {
  const notes = readRepoFile(`.github/releases/${currentReleaseTag}.md`);

  expect(notes).toContain(`# Butler ${currentReleaseTag}`);
  expect(notes).toContain("## Change Log");
  expect(notes).toContain("native file tool path");
  expect(notes).toContain("worker orchestration completion and diagnostics");
  expect(notes).toContain("orchestration regression coverage");
  expect(notes).toContain("pacman packaging support");
  expect(notes).toContain("(#30)");
  expect(notes).toContain("(#31)");
  expect(notes).toContain("(#35)");
  expect(notes).toContain("(#29)");
});
