import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_MANAGED_RUNTIME_POINTER_SCHEMA,
  appManagedAgentPointerPath,
} from "../../packages/butler-app/client/electron/app-managed-runtime.mjs";
import { resolveOpenAIOAuthLoginHelper } from "../../packages/butler-app/client/electron/openai-oauth-login-helper.mjs";

test("OpenAI OAuth helper resolves from active App-managed Agent pointer", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-oauth-helper-"));
  try {
    const butlerData = join(root, "data");
    const runtimeHomeLabel = join("app", "runtime", "agent", "versions", "1.2.3");
    const runtimeHome = join(butlerData, runtimeHomeLabel);
    const scriptPath = join(
      runtimeHome,
      "packages",
      "butler-agent",
      "scripts",
      "openai-oauth-login.ts",
    );
    const runtime = join(
      runtimeHome,
      "packages",
      "butler-agent",
      "resources",
      "runtime",
      "bin",
      "bun",
    );
    mkdirSync(join(scriptPath, ".."), { recursive: true });
    mkdirSync(join(runtime, ".."), { recursive: true });
    writeFileSync(scriptPath, "");
    writeFileSync(runtime, "");
    writePointer(butlerData, runtimeHomeLabel);

    const helper = resolveOpenAIOAuthLoginHelper({
      butlerData,
      repoRoot: join(root, "repo"),
      resourcesPath: join(root, "missing-resources"),
      fallbackRuntime: "bun",
    });

    expect(helper).toEqual({
      source: "app-managed",
      scriptPath,
      runtime,
      butlerHome: runtimeHome,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenAI OAuth helper ignores unsafe App-managed runtime pointers", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-oauth-helper-"));
  try {
    const butlerData = join(root, "data");
    const repoRoot = join(root, "repo");
    const repoScript = join(
      repoRoot,
      "packages",
      "butler-agent",
      "scripts",
      "openai-oauth-login.ts",
    );
    mkdirSync(join(repoScript, ".."), { recursive: true });
    writeFileSync(repoScript, "");
    writePointer(butlerData, "../outside");

    const helper = resolveOpenAIOAuthLoginHelper({
      butlerData,
      repoRoot,
      resourcesPath: join(root, "missing-resources"),
      fallbackRuntime: "bun",
    });

    expect(helper).toEqual({
      source: "repo",
      scriptPath: repoScript,
      runtime: "bun",
      butlerHome: repoRoot,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenAI OAuth helper can require App-managed runtime without development fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-oauth-helper-"));
  try {
    const butlerData = join(root, "data");
    const repoRoot = join(root, "repo");
    const repoScript = join(
      repoRoot,
      "packages",
      "butler-agent",
      "scripts",
      "openai-oauth-login.ts",
    );
    mkdirSync(join(repoScript, ".."), { recursive: true });
    writeFileSync(repoScript, "");
    writePointer(butlerData, "../outside");

    const helper = resolveOpenAIOAuthLoginHelper({
      butlerData,
      repoRoot,
      resourcesPath: join(root, "missing-resources"),
      fallbackRuntime: "bun",
      allowBundledResourceFallback: false,
      allowDevelopmentFallback: false,
    });

    expect(helper).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenAI OAuth helper returns null when no helper script is present", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-oauth-helper-"));
  try {
    const helper = resolveOpenAIOAuthLoginHelper({
      butlerData: join(root, "data"),
      repoRoot: join(root, "repo"),
      resourcesPath: join(root, "missing-resources"),
      fallbackRuntime: "bun",
    });
    expect(helper).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writePointer(butlerData: string, runtimeHome: string): void {
  const pointerPath = appManagedAgentPointerPath(butlerData);
  mkdirSync(join(pointerPath, ".."), { recursive: true });
  writeFileSync(
    pointerPath,
    `${JSON.stringify({
      schema: APP_MANAGED_RUNTIME_POINTER_SCHEMA,
      product: "butler-app",
      gateway_profile: "electron",
      version: "1.2.3",
      runtime_home: runtimeHome,
      raw_text_included: false,
    }, null, 2)}\n`,
  );
  expect(readFileSync(pointerPath, "utf8")).toContain(runtimeHome);
  expect(existsSync(pointerPath)).toBe(true);
}
