import { expect, test } from "bun:test";
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
  expect(workflow).toContain("BUTLER_APP_MANAGED_BUN_LINUX_X64=$linux_bun");
  expect(workflow).toContain("ELF 64-bit.*x86-64");
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
  expect(workflow).toContain("dist/release/app/butler-app-*-linux-x64.tar.gz");
  expect(workflow).toContain("dist/release/app/butler-app-*-linux-x64.tar.gz.sha256");
  expect(workflow).toContain("dist/release/app/app-release-manifest.json");
  expect(workflow).toContain("dist/release/app/app-update-manifest.json");
  expect(publishIndex).toBeGreaterThan(verifyIndex);
  expect(workflow).toContain('gh release upload "$tag" "${files[@]}" --clobber');
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
  expect(quickStart).toContain("butler-app-<version>-darwin-arm64.pkg");
  expect(quickStart).toContain("butler-app-<version>-linux-x64.tar.gz");
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
  expect(script).toContain("BUTLER_DATA: dataDir");
  expect(script).toContain("BUTLER_HOME: root");
  expect(script).toContain("BUTLER_APP_SERVER_PORT: String(serverPort)");
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

test("current release notes describe the GitHub release changelog", () => {
  const notes = readRepoFile(`.github/releases/${currentReleaseTag}.md`);

  expect(notes).toContain(`# Butler ${currentReleaseTag}`);
  expect(notes).toContain("## Change Log");
  expect(notes).toContain("bounded concurrent session execution");
  expect(notes).toContain("WorkStream continuity");
  expect(notes).toContain("live context usage telemetry");
  expect(notes).toContain("scroll-to-bottom");
  expect(notes).toContain("Project Ledger dashboard freshness");
});
