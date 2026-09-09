import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import { PromptAssembler } from "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import { resolveRuntimeMessageLanguage, responseLanguageInstruction } from "../../packages/butler-agent/src/agent/output/messages.ts";
import type { StoredSessionBinding } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

test("UI settings never initialize or rewrite model response language", async () => {
  const dir = mkdtempSync(join(tmpdir(), "butler-language-authority-"));
  const configPath = join(dir, "butler.config.json");
  writeFileSync(configPath, JSON.stringify({ user: { language: "ko" } }));
  const server = createTestAppServer({ butlerData: dir, dbPath: join(dir, "app.sqlite"), port: 0 });
  const patch = async (path: string, value: unknown) => {
    const result = await fetch(`${server.url}${path}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
    });
    expect(result.status).toBe(200);
    return result.json();
  };
  try {
    for (const language of ["en", "ko"]) {
      await patch("settings", { language });
      expect(JSON.parse(readFileSync(configPath, "utf8")).user.responseLanguage).toBeUndefined();
      expect(resolveRuntimeMessageLanguage({ butlerData: dir })).toBe("en");
    }
    for (const response_language of ["ko", "en"] as const) {
      await patch("personalization", { response_language });
      for (const language of ["en", "ko"]) {
        await patch("settings", { language });
        expect(JSON.parse(readFileSync(configPath, "utf8")).user.responseLanguage).toBe(response_language);
        const personalization = await (await fetch(`${server.url}personalization`)).json();
        expect(personalization.data.response_language).toBe(response_language);
        expect(resolveRuntimeMessageLanguage({ butlerData: dir })).toBe(response_language);
        for (const role of ["butler", "steward", "worker"] as const) {
          const binding = { sessionId: `test/${role}`, role, workspacePath: dir,
            runtimeAdapterId: "codex-api", modelProviderId: "openai", modelRef: "openai/gpt-6-astra",
            transportBindings: [], metadata: {}, lifecycleState: "active",
            createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
          } as StoredSessionBinding;
          const context = new PromptAssembler({ butlerHome: dir, butlerData: dir }).buildTurnContext({
            binding, envelope: { eventId: "language-test", transport: "mock", accountId: "default",
              peer: { kind: "dm", id: "user" }, sender: { id: "user" },
              message: { id: "language", text: "한국어로 다시 답변해줘", timestamp: new Date().toISOString() } },
          });
          expect(context).toContain(`Assistant Response Language: ${response_language}`);
          expect(context).toContain(`Interface Language (app labels only): ${language}`);
          expect(context).not.toContain("User Language:");
        }
      }
    }
  } finally {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("response preference permits explicit language and translation requests", () => {
  const instruction = responseLanguageInstruction("English");
  expect(instruction).toContain("by default");
  expect(instruction).toContain("Follow the user's explicit request");
  expect(instruction).toContain("Interface language controls app labels only");
  expect(instruction).not.toContain("in this Turn.");
});
