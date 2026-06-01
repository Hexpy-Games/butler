import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const root = process.cwd();

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

test("v0.0.2 release notes describe the GitHub release changelog", () => {
  const notes = readRepoFile(".github/releases/v0.0.2.md");

  expect(notes).toContain("# Butler v0.0.2");
  expect(notes).toContain("## Change Log");
  expect(notes).toContain("Built Butler App web client");
  expect(notes).toContain("prebuilt native `butler` CLI launchers");
  expect(notes).toContain("interactive Docker installer");
  expect(notes).toContain("first-chat onboarding");
});
