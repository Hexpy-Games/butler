import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptAssembler } from "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import type { StoredSessionBinding } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import {
  readFirstChatOnboardingState,
  writeFirstChatOnboardingState,
} from "../../packages/butler-agent/src/personalization/onboarding.ts";
import { readPersonalizationProfile } from "../../packages/butler-agent/src/personalization/profile.ts";
import { readProfilingConsentSnapshot } from "../../packages/butler-agent/src/personalization/profiling.ts";
import { createButlerToolExecutor } from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";

function binding(workspacePath: string): StoredSessionBinding {
  const now = new Date(0).toISOString();
  return {
    sessionId: "butler/main",
    role: "butler",
    projectId: undefined,
    workspacePath,
    runtimeAdapterId: "codex-api",
    modelProviderId: "openai",
    modelRef: "openai/auto:codex-latest",
    transportBindings: [],
    metadata: {},
    lifecycleState: "active",
    createdAt: now,
    updatedAt: now,
  };
}

function turnContext(input: {
  butlerHome: string;
  butlerData: string;
  messageText?: string;
}): string {
  return new PromptAssembler({
    butlerHome: input.butlerHome,
    butlerData: input.butlerData,
  }).buildTurnContext({
    binding: binding(input.butlerHome),
    envelope: {
      eventId: "mock:first-chat-onboarding",
      transport: "app",
      accountId: "default",
      peer: { kind: "dm", id: "peer-1" },
      sender: { id: "user-1" },
      message: {
        id: "msg-1",
        text: input.messageText ?? "hello",
        timestamp: new Date(0).toISOString(),
      },
    },
  });
}

test("pending first-chat onboarding is dynamic turn context and disappears after completion", () => {
  const root = join(tmpdir(), `butler-first-chat-prompt-${Date.now()}`);
  const butlerHome = join(root, "home");
  const butlerData = join(root, "data");
  mkdirSync(join(butlerHome, "resources", "prompts"), { recursive: true });
  mkdirSync(join(butlerHome, "resources", "skills"), { recursive: true });
  mkdirSync(join(butlerHome, "resources", "personas", "templates", "ko"), { recursive: true });
  mkdirSync(join(butlerData, "personas"), { recursive: true });
  mkdirSync(join(butlerData, "cognition", "memory"), { recursive: true });
  writeFileSync(join(butlerHome, "resources", "prompts", "core.md"), "CORE", "utf8");
  writeFileSync(join(butlerHome, "resources", "prompts", "butler.md"), "BUTLER", "utf8");
  writeFileSync(
    join(butlerHome, "resources", "personas", "templates", "ko", "butler.md"),
    [
      "---",
      "name: butler",
      "description: 설정 설명은 드롭다운 보조 설명으로 쓰지 않습니다.",
      "preview: \"설정 프리셋 프리뷰\"",
      "---",
      "# {{butler_name}}",
      "",
      "설정 프리셋 본문",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(butlerData, "butler.config.json"),
    JSON.stringify({ user: { language: "ko" } }),
    "utf8",
  );

  try {
    const pending = turnContext({ butlerHome, butlerData });
    expect(pending).toContain("## First-Chat Onboarding");
    expect(pending).toContain("첫 대화 온보딩이 아직 완료되지 않았습니다.");
    expect(pending).toContain("update_onboarding_profile");
    expect(pending).toContain("설정의 페르소나 프리셋 선택지:");
    expect(pending).toContain("persona_preset id 값을 그대로");
    expect(pending).toContain("- persona_preset: butler (Butler) - 설정 프리셋 프리뷰");
    expect(pending).toContain("- 직접 편집");
    expect(pending).toContain("장기 사용자 프로필 학습을 허용할지");
    expect(pending).toContain("`off`");
    expect(pending).not.toContain("차분하고 헌신적이며 솔직한 기본 집사");

    writeFirstChatOnboardingState(butlerData, {
      ...readFirstChatOnboardingState(butlerData),
      status: "complete",
      updated_at: "2026-05-18T00:00:00.000Z",
      completed_at: "2026-05-18T00:00:00.000Z",
    });

    const complete = turnContext({ butlerHome, butlerData });
    expect(complete).not.toContain("## First-Chat Onboarding");
    expect(complete).not.toContain("첫 대화 온보딩이 아직 완료되지 않았습니다.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("update_onboarding_profile persists profile persona and raw-text-free onboarding status", async () => {
  const root = join(tmpdir(), `butler-first-chat-tool-${Date.now()}`);
  const butlerHome = join(root, "home");
  const butlerData = join(root, "data");
  mkdirSync(join(butlerHome, "resources", "personas", "templates", "en"), { recursive: true });
  writeFileSync(
    join(butlerHome, "resources", "personas", "templates", "en", "operator.md"),
    [
      "---",
      "name: operator",
      "description: Test operator persona.",
      "---",
      "# {{butler_name}}",
      "",
      "Act with calm operational clarity.",
    ].join("\n"),
    "utf8",
  );

  try {
    const execute = createButlerToolExecutor({
      butlerHome,
      butlerData,
      sessionId: "butler/main",
    });
    const result = await execute({
      name: "update_onboarding_profile",
      args: {
        principal_name: "Avery",
        preferred_address: "Captain",
        butler_nickname: "Jeeves",
        interests: "quiet notebooks and small operating systems",
        work: "developer tools",
        service_preference: "speak gently but act decisively",
        persona_preset: "operator",
        profiling_mode: "basic",
        complete: true,
        locale: "en",
      },
      rawArguments: "{}",
    }) as {
      ok: boolean;
      status: string;
      updated_fields: string[];
      persona: { preset: string | null; applied: boolean };
      profiling: { mode: string; raw_text_included: false };
      storage_label: string;
    };

    expect(result.ok).toBe(true);
    expect(result.status).toBe("complete");
    expect(result.updated_fields).toContain("principal_name");
    expect(result.updated_fields).toContain("persona_preset");
    expect(result.updated_fields).toContain("profiling_mode");
    expect(result.persona).toEqual({ preset: "operator", applied: true });
    expect(result.profiling.mode).toBe("basic");
    expect(result.profiling.raw_text_included).toBe(false);
    expect(result.storage_label).toBe("personalization/onboarding.json");
    expect(JSON.stringify(result)).not.toContain("quiet notebooks");

    const profile = readPersonalizationProfile(butlerData);
    expect(profile).toMatchObject({
      principal_name: "Avery",
      preferred_address: "Captain",
      butler_nickname: "Jeeves",
    });
    const onboarding = readFirstChatOnboardingState(butlerData);
    expect(onboarding.status).toBe("complete");
    expect(onboarding.fields.interests).toBe("quiet notebooks and small operating systems");
    expect(onboarding.fields.work).toBe("developer tools");
    expect(onboarding.fields.service_preference).toBe("speak gently but act decisively");
    expect(onboarding.fields.persona_preset).toBe("operator");
    expect(onboarding.fields.profiling_mode).toBe("basic");

    const activePersona = readFileSync(join(butlerData, "personas", "active.md"), "utf8");
    expect(activePersona).toContain("base: operator");
    expect(activePersona).toContain("# Jeeves");
    const config = JSON.parse(readFileSync(join(butlerData, "butler.config.json"), "utf8"));
    expect(config.butler.name).toBe("Jeeves");
    expect(config.system.activePersona).toBe("operator");
    expect(readProfilingConsentSnapshot(butlerData).mode).toBe("basic");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("onboarding persona selection resolves displayed preset text to the real preset", async () => {
  const root = join(tmpdir(), `butler-first-chat-persona-label-${Date.now()}`);
  const butlerHome = join(root, "home");
  const butlerData = join(root, "data");
  mkdirSync(join(butlerHome, "resources", "personas", "templates", "en"), { recursive: true });
  writeFileSync(
    join(butlerHome, "resources", "personas", "templates", "en", "operator.md"),
    [
      "---",
      "name: operator",
      "description: Test operator persona.",
      "preview: Command received. I will keep the board clean.",
      "---",
      "# {{butler_name}}",
      "",
      "Act with calm operational clarity from the real preset body.",
    ].join("\n"),
    "utf8",
  );

  try {
    const execute = createButlerToolExecutor({
      butlerHome,
      butlerData,
      sessionId: "butler/main",
    });
    const result = await execute({
      name: "update_onboarding_profile",
      args: {
        butler_nickname: "Jeeves",
        persona_preset: "Operator - Command received. I will keep the board clean.",
        complete: true,
        locale: "en",
      },
      rawArguments: "{}",
    }) as {
      ok: boolean;
      persona: { preset: string | null; applied: boolean };
    };

    expect(result.ok).toBe(true);
    expect(result.persona).toEqual({ preset: "operator", applied: true });
    const onboarding = readFirstChatOnboardingState(butlerData);
    expect(onboarding.fields.persona_preset).toBe("operator");
    expect(onboarding.fields.persona_custom).toBeUndefined();
    const activePersona = readFileSync(join(butlerData, "personas", "active.md"), "utf8");
    expect(activePersona).toContain("base: operator");
    expect(activePersona).toContain("Act with calm operational clarity from the real preset body.");
    expect(activePersona).not.toContain("base: custom");
    const config = JSON.parse(readFileSync(join(butlerData, "butler.config.json"), "utf8"));
    expect(config.system.activePersona).toBe("operator");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("custom onboarding persona is applied directly", async () => {
  const root = join(tmpdir(), `butler-first-chat-custom-${Date.now()}`);
  const butlerHome = join(root, "home");
  const butlerData = join(root, "data");
  mkdirSync(butlerHome, { recursive: true });

  try {
    const execute = createButlerToolExecutor({
      butlerHome,
      butlerData,
      sessionId: "butler/main",
    });
    const result = await execute({
      name: "update_onboarding_profile",
      args: {
        butler_nickname: "Orbit",
        persona_preset: "custom",
        persona_custom: "Be warm, concise, and gently proactive.",
        complete: true,
        locale: "en",
      },
      rawArguments: "{}",
    }) as {
      ok: boolean;
      persona: { preset: string | null; applied: boolean };
    };

    expect(result.ok).toBe(true);
    expect(result.persona).toEqual({ preset: "custom", applied: true });
    const activePersona = readFileSync(join(butlerData, "personas", "active.md"), "utf8");
    expect(activePersona).toContain("base: custom");
    expect(activePersona).toContain("# Orbit");
    expect(activePersona).toContain("Be warm, concise, and gently proactive.");
    const config = JSON.parse(readFileSync(join(butlerData, "butler.config.json"), "utf8"));
    expect(config.system.activePersona).toBe("custom");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("onboarding profile update leaves black-box profiling off unless mode is explicit", async () => {
  const root = join(tmpdir(), `butler-first-chat-profiling-off-${Date.now()}`);
  const butlerHome = join(root, "home");
  const butlerData = join(root, "data");
  mkdirSync(butlerHome, { recursive: true });

  try {
    const execute = createButlerToolExecutor({
      butlerHome,
      butlerData,
      sessionId: "butler/main",
    });
    const result = await execute({
      name: "update_onboarding_profile",
      args: {
        principal_name: "Avery",
        interests: "quiet notebooks",
      },
      rawArguments: "{}",
    }) as {
      ok: boolean;
      profiling: { mode: string; captured_candidate_count: number; raw_text_included: false };
    };

    expect(result.ok).toBe(true);
    expect(result.profiling).toEqual({
      mode: "off",
      captured_candidate_count: 0,
      raw_text_included: false,
    });
    expect(readProfilingConsentSnapshot(butlerData).mode).toBe("off");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("onboarding records explicit profile learning decline as asked state", async () => {
  const root = join(tmpdir(), `butler-first-chat-profiling-decline-${Date.now()}`);
  const butlerHome = join(root, "home");
  const butlerData = join(root, "data");
  mkdirSync(butlerHome, { recursive: true });

  try {
    const execute = createButlerToolExecutor({
      butlerHome,
      butlerData,
      sessionId: "butler/main",
    });
    const result = await execute({
      name: "update_onboarding_profile",
      args: {
        profiling_mode: "off",
      },
      rawArguments: "{}",
    }) as {
      ok: boolean;
      updated_fields: string[];
      profiling: { mode: string; captured_candidate_count: number; raw_text_included: false };
    };

    expect(result.ok).toBe(true);
    expect(result.updated_fields).toContain("profiling_mode");
    expect(result.profiling).toEqual({
      mode: "off",
      captured_candidate_count: 0,
      raw_text_included: false,
    });
    const onboarding = readFirstChatOnboardingState(butlerData);
    expect(onboarding.fields.profiling_mode).toBe("off");
    expect(readProfilingConsentSnapshot(butlerData).mode).toBe("off");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
