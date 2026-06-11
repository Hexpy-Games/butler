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

test("version tag release workflow publishes service artifact with packaged app client", () => {
  const workflowPath = join(root, ".github", "workflows", "release.yml");
  expect(existsSync(workflowPath)).toBe(true);
  const workflow = readFileSync(workflowPath, "utf8");

  const gateIndex = workflow.indexOf("bun run release:service:gate");
  const packageIndex = workflow.indexOf("bun run release:service:package");
  const verifyIndex = workflow.indexOf(
    "Verify packaged Butler App web client",
  );
  const publishIndex = workflow.indexOf("Publish GitHub Release");

  expect(workflow).toContain("tags:\n      - \"v*\"");
  expect(workflow).toContain("contents: write");
  expect(workflow).toContain("bun install --frozen-lockfile");
  expect(workflow).toContain("npm --prefix packages/butler-app/client/ui ci");
  expect(gateIndex).toBeGreaterThan(-1);
  expect(packageIndex).toBeGreaterThan(gateIndex);
  expect(verifyIndex).toBeGreaterThan(packageIndex);
  expect(publishIndex).toBeGreaterThan(verifyIndex);
  expect(workflow).toContain(
    "./packages/butler-agent/resources/app-client/dist/index.html",
  );
  expect(workflow).toContain(
    "./packages/butler-agent/resources/app-client/dist/assets/",
  );
  expect(workflow).toContain(
    "dist/release/service/butler-service-*-all.tar.gz",
  );
  expect(workflow).toContain("--artifact-base-url");
  expect(workflow).toContain(
    "https://github.com/${GITHUB_REPOSITORY}/releases/download/${GITHUB_REF_NAME}",
  );
  expect(workflow).toContain(
    "dist/release/service/butler-service-*-all.tar.gz.sha256",
  );
  expect(workflow).toContain(
    "dist/release/service/service-release-manifest.json",
  );
  expect(workflow).toContain("dist/release/service/update-manifest.json");
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

  const serviceJobIndex = workflow.indexOf("service-artifact:");
  const appJobIndex = workflow.indexOf("app-artifact:");
  const packageIndex = workflow.indexOf("bun run release:app:package");
  const verifyIndex = workflow.indexOf("Verify packaged app artifacts");
  const publishIndex = workflow.indexOf("Publish app GitHub Release files");

  expect(appJobIndex).toBeGreaterThan(serviceJobIndex);
  expect(workflow).toContain("runs-on: macos-latest");
  expect(workflow).toContain("needs: service-artifact");
  expect(workflow).toContain("npm --prefix packages/butler-app/client/electron ci");
  expect(workflow).toContain("bun run release:app:gate");
  expect(packageIndex).toBeGreaterThan(appJobIndex);
  expect(workflow).toContain("--artifact-base-url");
  expect(verifyIndex).toBeGreaterThan(packageIndex);
  expect(workflow).toContain("codesign --verify --deep --strict --verbose=4");
  expect(workflow).toContain('grep -F "Butler-linux-x64/Butler"');
  expect(workflow).toContain("dist/release/app/butler-app-*-darwin-arm64.zip");
  expect(workflow).toContain("dist/release/app/butler-app-*-darwin-arm64.zip.sha256");
  expect(workflow).toContain("dist/release/app/butler-app-*-linux-x64.tar.gz");
  expect(workflow).toContain("dist/release/app/butler-app-*-linux-x64.tar.gz.sha256");
  expect(workflow).toContain("dist/release/app/app-release-manifest.json");
  expect(workflow).toContain("dist/release/app/app-update-manifest.json");
  expect(publishIndex).toBeGreaterThan(verifyIndex);
  expect(workflow).toContain('gh release upload "$tag" "${files[@]}" --clobber');
});

test("README directs user installs to tag artifacts instead of source checkout", () => {
  const readme = readRepoFile("README.md");
  const quickStartStart = readme.indexOf("## Quick Start");
  const howButlerWorksStart = readme.indexOf("## How Butler Works");
  const developmentStart = readme.indexOf("## Development");

  expect(quickStartStart).toBeGreaterThan(-1);
  expect(howButlerWorksStart).toBeGreaterThan(quickStartStart);
  expect(developmentStart).toBeGreaterThan(howButlerWorksStart);

  const quickStart = readme.slice(quickStartStart, howButlerWorksStart);
  const normalizedQuickStart = normalizeWhitespace(quickStart);
  const development = readme.slice(developmentStart);

  expect(quickStart).toContain("GitHub Release");
  expect(quickStart).toContain("butler-service-*-all.tar.gz");
  expect(normalizedQuickStart).toContain(
    "Release artifacts already include the built Butler App web client",
  );
  expect(quickStart).toContain("./install.sh");
  expect(quickStart).not.toContain("git clone");
  expect(quickStart).not.toContain("bun install");
  expect(development).toContain(
    "git clone https://github.com/Hexpy-Games/butler.git ~/butler",
  );
  expect(development).toContain("bun install");
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
