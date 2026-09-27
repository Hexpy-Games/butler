import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOpenAIAuthProfilePath, resolveOpenAIOAuthLoginHelper } from "../../packages/butler-app/client/electron/openai-oauth-login-helper.mjs";

test("OpenAI OAuth helper uses the installed native executable and immutable resources", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-oauth-helper-"));
  try {
    const resourcesPath = join(root, "resources");
    const binary = join(resourcesPath, "bundled-agent", "bin", "butler-agent");
    const resourceRoot = join(resourcesPath, "bundled-agent", "resources");
    const execPath = join(root, "electron");
    const butlerData = join(root, "data");
    mkdirSync(join(binary, ".."), { recursive: true });
    mkdirSync(resourceRoot, { recursive: true });
    writeFileSync(binary, "");
    chmodSync(binary, 0o755);
    writeFileSync(execPath, "");
    expect(resolveOpenAIOAuthLoginHelper({ butlerData, resourcesPath, execPath, platform: "linux" })).toEqual({
      command: binary,
      args: ["--installation-root", root, "--resource-root", resourceRoot, "oauth-login"],
      env: { BUTLER_DATA: butlerData },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenAI OAuth helper requires the packaged native payload", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-oauth-helper-"));
  try {
    expect(() => resolveOpenAIOAuthLoginHelper({
      butlerData: join(root, "data"),
      resourcesPath: join(root, "missing"),
      execPath: join(root, "electron"),
      platform: "linux",
    })).toThrow("missing bundled native Agent resources");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenAI OAuth helper uses the explicit native installation in development", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-oauth-native-dev-"));
  try {
    const installationRoot = join(root, "installation");
    const binary = join(installationRoot, "bin", "butler-agent");
    const alias = join(root, "agent-alias");
    const resourceRoot = join(installationRoot, "resources");
    const butlerData = join(root, "data");
    mkdirSync(join(binary, ".."), { recursive: true });
    mkdirSync(resourceRoot);
    writeFileSync(binary, "native executable fixture\n");
    chmodSync(binary, 0o755);
    symlinkSync(binary, alias);
    const actualBinary = realpathSync(binary);
    const actualInstallationRoot = join(actualBinary, "..", "..");
    expect(resolveOpenAIOAuthLoginHelper({
      butlerData,
      isPackaged: false,
      env: { BUTLER_NATIVE_AGENT_EXECUTABLE: alias, BUTLER_HOME: join(root, "misleading") },
      resourcesPath: join(root, "missing-resources"),
    })).toEqual({
      command: actualBinary,
      args: ["--installation-root", actualInstallationRoot, "--resource-root", join(actualInstallationRoot, "resources"), "oauth-login"],
      env: { BUTLER_DATA: butlerData },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenAI OAuth profile reader follows an in-data override and rejects outside paths", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-oauth-profile-"));
  try {
    const butlerData = join(root, "data");
    mkdirSync(butlerData);
    const configured = join(butlerData, "auth", "custom.json");
    const canonical = join(realpathSync(butlerData), "auth", "custom.json");
    expect(resolveOpenAIAuthProfilePath({ butlerData, env: { BUTLER_CODEX_AUTH_PROFILE: configured } })).toBe(canonical);
    expect(resolveOpenAIAuthProfilePath({ butlerData, env: { BUTLER_OPENAI_AUTH_PROFILE: "auth/custom.json" } })).toBe(canonical);
    expect(() => resolveOpenAIAuthProfilePath({ butlerData, env: { BUTLER_CODEX_AUTH_PROFILE: join(root, "outside.json") } })).toThrow("inside BUTLER_DATA");
    symlinkSync(root, join(butlerData, "outside-link"));
    expect(() => resolveOpenAIAuthProfilePath({ butlerData, env: { BUTLER_CODEX_AUTH_PROFILE: "outside-link/profile.json" } })).toThrow("inside BUTLER_DATA");
    symlinkSync(join(root, "new-outside.json"), join(butlerData, "dangling-link.json"));
    expect(() => resolveOpenAIAuthProfilePath({ butlerData, env: { BUTLER_CODEX_AUTH_PROFILE: "dangling-link.json" } })).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
