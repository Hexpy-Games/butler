import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { AgentConversationStore, conversationStorePath } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { runCognitionConsolidationCycle } from "../../packages/butler-agent/src/agent/cognition/consolidation/cycle.ts";
import { acquireConsolidationLock, consolidationLockPath, releaseConsolidationLock } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/lib/lock.ts";
import {
  captureProfileCandidatesFromFeedback,
  captureProfileCandidatesFromTranscripts,
  captureProfileCandidatesFromTranscriptsWithModel,
  clearProfilingData,
  consolidateProfileCandidates,
  importProfileCandidatesFromThirdPartyDumpWithModel,
  listProfileCandidates,
  listStableProfileEntries,
  profileThirdPartyMigrationPrompt,
  profileBlackBoxPath,
  readProfilingExtractorModelConfig,
  readReflectiveProfileSummary,
  readRuntimeProfileProjection,
  renderRuntimeProfileProjectionPrompt,
  setProfilingExtractorModel,
  upsertProfileCandidate,
  writeProfilingConsentSnapshot,
  writeRuntimeProfileProjection,
} from "../../packages/butler-agent/src/personalization/profiling.ts";

function writeConversationProfileMessages(
  butlerData: string,
  messages: Array<{ id: string; timestamp: string; text: string }>,
): void {
  let next = 0;
  const store = new AgentConversationStore({
    butlerData,
    idFactory: (prefix) => `${prefix}_profile_${++next}`,
  });
  try {
    const turn = store.beginTurn({
      gateway: "app",
      externalSessionId: "general",
      sessionId: "cs_profile",
      actor: "user",
      now: messages[0]?.timestamp ?? "2026-05-17T00:00:00.000Z",
    });
    for (const message of messages) {
      store.appendUserMessage({
        sessionId: "cs_profile",
        turnId: turn.id,
        messageId: `cm_${message.id}`,
        text: message.text,
        sourceGateway: "app",
        sourceRef: message.id,
        originKind: "user_input",
        now: message.timestamp,
      });
    }
  } finally {
    store.close();
  }
}

test("profiling black box uses sqlite and renders only runtime projection hints", () => {
  const butlerData = join(tmpdir(), `butler-profile-${Date.now()}-${Math.random()}`);
  try {
    const consent = writeProfilingConsentSnapshot(butlerData, { mode: "deep" });
    expect(consent).toMatchObject({
      mode: "deep",
      raw_profile_browser_visible: false,
    });
    const path = profileBlackBoxPath(butlerData);
    expect(path.endsWith("cognition/profile/profile.sqlite")).toBe(true);
    expect(existsSync(path)).toBe(true);

    const db = new Database(path, { readonly: true });
    try {
      const tables = db.query(`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
        ORDER BY name
      `).all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toContain("profile_candidates");
      expect(tables.map((row) => row.name)).toContain("stable_profile_entries");
      expect(tables.map((row) => row.name)).toContain("runtime_projection");
    } finally {
      db.close();
    }

    writeRuntimeProfileProjection(butlerData, {
      version: 7,
      mode: "deep",
      updated_at: "2026-05-16T00:00:00.000Z",
      how_to_answer: ["Prefer short, verified implementation reports."],
      how_to_collaborate: [],
      response_hints: ["Prefer short, verified implementation reports."],
      current_attention: ["Profiling architecture is active."],
      active_boundaries: ["Do not expose raw profile or candidate evidence."],
      likely_failure_modes: [],
      ask_before: [],
      caution_hints: ["Do not expose raw profile or candidate evidence."],
    });

    const projection = readRuntimeProfileProjection(butlerData);
    const prompt = renderRuntimeProfileProjectionPrompt(projection);
    expect(prompt).toContain("Prefer short, verified implementation reports.");
    expect(prompt).toContain("Do not expose raw profile or candidate evidence.");
    expect(prompt).not.toContain("profile_candidates");
    expect(prompt).not.toContain("stable_profile_entries");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("non-model profiling conversation capture scans without heuristic candidates", () => {
  const butlerData = join(tmpdir(), `butler-profile-${Date.now()}-${Math.random()}`);
  try {
    writeProfilingConsentSnapshot(butlerData, {
      mode: "deep",
      consented_at: "2026-05-17T00:00:00.000Z",
    });
    writeConversationProfileMessages(butlerData, [
      { id: "evt_1", timestamp: "2026-05-17T00:01:00.000Z", text: "버틀러는 임시방편보다 구조적으로 고쳐야 해. 실제로 재현하고 확인까지 해야 해." },
      { id: "evt_2", timestamp: "2026-05-17T00:02:00.000Z", text: "프로파일링과 페르소나는 동의 기반으로 로컬에 두고, 원시 프롬프트나 세부 로그는 노출하지 마." },
      { id: "evt_3", timestamp: "2026-05-17T00:03:00.000Z", text: "버틀러의 워커 오케스트레이션은 실제 대화 유즈케이스에서 작동하는지 검증해야 해." },
    ]);

    const capture = captureProfileCandidatesFromTranscripts(butlerData);
    expect(capture).toMatchObject({
      profiling_enabled: true,
      mode: "deep",
      scanned_file_count: 1,
      scanned_event_count: 3,
      semantic_scanned_session_count: 1,
      semantic_scanned_message_count: 3,
      audit_transcript_scanned_file_count: 0,
      audit_transcript_scanned_event_count: 0,
      raw_text_included: false,
    });
    expect(capture.captured_candidate_count).toBe(0);
    expect(JSON.stringify(listProfileCandidates(butlerData))).not.toContain("원시 프롬프트나 세부 로그");

    const result = consolidateProfileCandidates(butlerData);
    expect(result.projection_written).toBe(false);
    expect(result.promoted_count).toBe(0);
    const reflective = readReflectiveProfileSummary(butlerData, "ko");
    expect(reflective.bullets).toEqual([]);
    expect(reflective.raw_profile_included).toBe(false);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("profiling extractor uses the configured model without heuristic fallback", async () => {
  const butlerData = join(tmpdir(), `butler-profile-${Date.now()}-${Math.random()}`);
  try {
    mkdirSync(butlerData, { recursive: true });
    writeFileSync(join(butlerData, "butler.config.json"), JSON.stringify({
      system: { defaultModel: "openai/gpt-5.4" },
      personalization: { profiling: { extractorModel: "default" } },
    }, null, 2), "utf8");
    writeProfilingConsentSnapshot(butlerData, {
      mode: "deep",
      consented_at: "2026-05-17T00:00:00.000Z",
    });
    writeConversationProfileMessages(butlerData, [
      { id: "evt_1", timestamp: "2026-05-17T00:01:00.000Z", text: "임시방편보다 구조를 먼저 고쳐줘." },
      { id: "evt_2", timestamp: "2026-05-17T00:02:00.000Z", text: "고쳤다고 말하기 전에 실제로 재현하고 검증해줘." },
    ]);

    expect(readProfilingExtractorModelConfig(butlerData)).toMatchObject({
      configured_model: null,
      effective_model: "openai/gpt-5.4",
      uses_butler_model: true,
    });

    const capture = await captureProfileCandidatesFromTranscriptsWithModel(butlerData, {
      modelRunner: async (input) => {
        expect(input.model).toBe("openai/gpt-5.4");
        const prompt = JSON.parse(input.prompt) as { observations: Array<{ ref: string }> };
        expect(prompt.observations.length).toBeGreaterThan(1);
        return JSON.stringify({
          candidates: [{
            category: "epistemic_style",
            summary: "Prefers structural fixes and verified completion over shallow patches.",
            source_type: "repeated_observation",
            confidence: "medium",
            evidence_refs: prompt.observations.map((observation) => observation.ref),
            sensitive_domain: false,
            expires_or_decay: "decay",
          }],
        });
      },
    });

    expect(capture).toMatchObject({
      profiling_enabled: true,
      mode: "deep",
      scanned_file_count: 1,
      scanned_event_count: 2,
      semantic_scanned_session_count: 1,
      semantic_scanned_message_count: 2,
      audit_transcript_scanned_file_count: 0,
      audit_transcript_scanned_event_count: 0,
      captured_candidate_count: 1,
      model_called: true,
      fallback_used: false,
      raw_text_included: false,
    });
    expect(JSON.stringify(listProfileCandidates(butlerData))).not.toContain("임시방편보다");

    const result = consolidateProfileCandidates(butlerData);
    expect(result.promoted_count).toBe(1);
    expect(readReflectiveProfileSummary(butlerData, "ko").bullets.join("\n"))
      .toContain("structural fixes");

    expect(setProfilingExtractorModel(butlerData, "openai/gpt-5.5")).toMatchObject({
      configured_model: "openai/gpt-5.5",
      effective_model: "openai/gpt-5.5",
      uses_butler_model: false,
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("profiling extractor preserves philosophical profile facets", async () => {
  const butlerData = join(tmpdir(), `butler-profile-${Date.now()}-${Math.random()}`);
  try {
    writeProfilingConsentSnapshot(butlerData, {
      mode: "deep",
      consented_at: "2026-05-17T00:00:00.000Z",
    });
    writeConversationProfileMessages(butlerData, [
      { id: "evt_interest", timestamp: "2026-05-17T00:01:00.000Z", text: "최근에는 버틀러의 프로파일링과 페르소나 완성도가 제일 중요해." },
      { id: "evt_event", timestamp: "2026-05-17T00:02:00.000Z", text: "실제 세션에서 모델 호출 없이 프로파일이 만들어진 걸 보고 방향을 다시 잡았어." },
    ]);

    await captureProfileCandidatesFromTranscriptsWithModel(butlerData, {
      modelRunner: async (input) => {
        expect(input.instructions).toContain("current_interests");
        expect(input.instructions).toContain("meaningful_events");
        const prompt = JSON.parse(input.prompt) as { observations: Array<{ ref: string; text: string }> };
        return JSON.stringify({
          candidates: prompt.observations.map((observation) => ({
              ...(observation.text.includes("프로파일링과 페르소나") ? {
              category: "cares",
              facet: "current_interests",
              summary: "Recently focuses on Butler profiling and persona quality.",
              } : {
              category: "narrative",
              facet: "meaningful_events",
              summary: "Changed direction after seeing a mechanical non-model profile extraction result.",
              }),
              source_type: "explicit",
              confidence: "high",
              evidence_refs: [observation.ref],
              sensitive_domain: false,
              expires_or_decay: "decay",
            })),
        });
      },
    });
    const result = consolidateProfileCandidates(butlerData);
    expect(result.promoted_count).toBe(2);
    const entries = listStableProfileEntries(butlerData);
    expect(entries).toContainEqual(expect.objectContaining({
      layer: "current_attention",
      category: "cares",
      facet: "current_interests",
      summary: "Recently focuses on Butler profiling and persona quality.",
      temporal_scope: "active",
    }));
    expect(entries).toContainEqual(expect.objectContaining({
      layer: "narrative_meaning",
      category: "narrative",
      facet: "meaningful_events",
      summary: "Changed direction after seeing a mechanical non-model profile extraction result.",
    }));
    expect(readReflectiveProfileSummary(butlerData, "ko").bullets.join("\n"))
      .toContain("최근 관심사");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("profiling extractor backfills historical interests across long conversation batches", async () => {
  const butlerData = join(tmpdir(), `butler-profile-${Date.now()}-${Math.random()}`);
  try {
    writeProfilingConsentSnapshot(butlerData, {
      mode: "deep",
      consented_at: "2026-05-17T00:00:00.000Z",
    });
    writeConversationProfileMessages(butlerData, [
      { id: "evt_hsr", timestamp: "2026-05-06T11:57:47.758Z", text: "스타레일은 새로운 떡밥 올라온거 없어?" },
      ...Array.from({ length: 230 }, (_, index) =>
        ({
          id: `evt_recent_${index}`,
          timestamp: `2026-05-17T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
          text: `최근 버틀러 프로파일링 점검 메시지 ${index}`,
        }),
      ),
    ]);

    let sawHistoricalInterest = false;
    const capture = await captureProfileCandidatesFromTranscriptsWithModel(butlerData, {
      maxUserMessages: 260,
      modelRunner: async (input) => {
        const prompt = JSON.parse(input.prompt) as { observations: Array<{ ref: string; text: string }> };
        const observation = prompt.observations[0]!;
        if (!observation.text.includes("스타레일")) return JSON.stringify({ candidates: [] });
        sawHistoricalInterest = true;
        return JSON.stringify({
          candidates: [{
            category: "cares",
            facet: "current_interests",
            summary: "Recently shows interest in Honkai: Star Rail story updates.",
            source_type: "explicit",
            confidence: "medium",
            evidence_refs: [observation.ref],
            sensitive_domain: false,
            expires_or_decay: "decay",
          }],
        });
      },
    });

    expect(sawHistoricalInterest).toBe(true);
    expect(capture).toMatchObject({
      profiling_enabled: true,
      mode: "deep",
      captured_candidate_count: 1,
      model_called: true,
      fallback_used: false,
      raw_text_included: false,
    });
    expect(listProfileCandidates(butlerData)).toContainEqual(expect.objectContaining({
      category: "cares",
      facet: "current_interests",
      summary: "Recently shows interest in Honkai: Star Rail story updates.",
    }));
    const consolidation = consolidateProfileCandidates(butlerData);
    expect(consolidation.promoted_count).toBe(1);
    expect(listStableProfileEntries(butlerData)).toContainEqual(expect.objectContaining({
      category: "cares",
      facet: "current_interests",
      summary: "Recently shows interest in Honkai: Star Rail story updates.",
    }));
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("deep profile migration applies imported profile candidates without retaining raw dump", async () => {
  const butlerData = join(tmpdir(), `butler-profile-${Date.now()}-${Math.random()}`);
  try {
    const migrationPrompt = profileThirdPartyMigrationPrompt("ko");
    expect(migrationPrompt).toContain("저장한 모든 기억");
    expect(migrationPrompt).toContain("## Categories");
    expect(migrationPrompt).toContain("## Instructions");
    expect(migrationPrompt).toContain("[YYYY-MM-DD]");
    expect(migrationPrompt).toContain("완전한 전체 목록인지");
    expect(migrationPrompt).toContain("비밀번호");
    expect(migrationPrompt).not.toContain("Butler");
    const englishMigrationPrompt = profileThirdPartyMigrationPrompt("en");
    expect(englishMigrationPrompt).toContain("Export all of my stored memories");
    expect(englishMigrationPrompt).toContain("## Instructions");
    expect(englishMigrationPrompt).toContain("[YYYY-MM-DD]");
    expect(englishMigrationPrompt).toContain("complete set");
    expect(englishMigrationPrompt).not.toContain("Butler");
    writeProfilingConsentSnapshot(butlerData, {
      mode: "deep",
      consented_at: "2026-05-17T00:00:00.000Z",
    });
    const rawDump = JSON.stringify({
      user_profile_export: {
        current_interests: ["붕괴 스타레일 스토리와 Butler 개인화 기능"],
        work_style: ["임시방편보다 구조적 해결과 검증을 선호"],
        sensitive_or_uncertain: ["raw dump sentinel should never persist"],
      },
    });

    const imported = await importProfileCandidatesFromThirdPartyDumpWithModel(
      butlerData,
      {
        source: "ChatGPT",
        text: rawDump,
        now: new Date("2026-05-17T01:00:00.000Z"),
        modelRunner: async (input) => {
          expect(input.instructions).toContain("third-party imported profile candidates");
          expect(input.instructions).toContain("Do not mark ordinary language");
          expect(input.prompt).toContain("Import source: chatgpt");
          expect(input.prompt).toContain("raw dump sentinel");
          const evidenceRef = input.prompt.match(/Import ref: ([^\n]+)/u)?.[1] ?? "";
          return JSON.stringify({
            candidates: [
              {
                layer: "current_attention",
                category: "cares",
                facet: "current_interests",
                summary: "Currently tracks Honkai: Star Rail story and Butler personalization quality.",
                applies_when: ["casual_chat", "product_discussion"],
                butler_should: ["use these interests only when relevant"],
                butler_should_not: ["overfit unrelated answers"],
                temporal_scope: "active",
                decay_policy: "days_30",
                source_type: "inference",
                confidence: "high",
                evidence_refs: [evidenceRef],
                sensitive_domain: false,
                sensitivity: "normal",
                expires_or_decay: "decay",
              },
              {
                layer: "narrative_meaning",
                category: "identity",
                facet: "self_descriptions",
                summary: "User goes by Example User and primarily communicates in Korean.",
                applies_when: ["addressing_user"],
                butler_should: ["respect the user's chosen name and language"],
                butler_should_not: ["treat inferred identity context as legal identity"],
                temporal_scope: "durable",
                decay_policy: "reinforce_or_decay",
                source_type: "inference",
                confidence: "high",
                evidence_refs: [evidenceRef],
                sensitive_domain: true,
                sensitivity: "sensitive",
                expires_or_decay: "decay",
              },
              {
                layer: "contextual_adaptation",
                category: "relationships",
                facet: "collaboration_preferences",
                summary: "User expects the assistant to behave like a critical peer or capable collaborator rather than a passive helper.",
                applies_when: ["problem_solving", "planning"],
                butler_should: ["surface missed assumptions"],
                butler_should_not: ["act as a passive helper"],
                temporal_scope: "durable",
                decay_policy: "reinforce_or_decay",
                source_type: "inference",
                confidence: "high",
                evidence_refs: [evidenceRef],
                sensitive_domain: true,
                sensitivity: "sensitive",
                expires_or_decay: "decay",
              },
              {
                layer: "contextual_adaptation",
                category: "boundaries",
                facet: "sensitive_domains",
                summary: "Sensitive imported health context should be treated as deep personalization context.",
                applies_when: ["health_context"],
                butler_should: ["use this context carefully in deep personalization mode"],
                butler_should_not: ["reuse sensitive context casually"],
                temporal_scope: "durable",
                decay_policy: "never_without_consent",
                source_type: "inference",
                confidence: "high",
                evidence_refs: [evidenceRef],
                sensitive_domain: true,
                sensitivity: "sensitive",
                expires_or_decay: "decay",
              },
            ],
          });
        },
      },
    );

    expect(imported).toMatchObject({
      profiling_enabled: true,
      mode: "deep",
      source: "chatgpt",
      imported_candidate_count: 4,
      promoted_count: 4,
      skipped_count: 0,
      model_called: true,
      fallback_used: false,
      raw_text_included: false,
    });
    expect(listStableProfileEntries(butlerData)).toContainEqual(expect.objectContaining({
      category: "cares",
      facet: "current_interests",
      summary: "Currently tracks Honkai: Star Rail story and Butler personalization quality.",
      sensitive_domain: false,
    }));
    expect(listStableProfileEntries(butlerData)).toContainEqual(expect.objectContaining({
      category: "identity",
      facet: "self_descriptions",
      summary: "User goes by Example User and primarily communicates in Korean.",
      sensitive_domain: false,
    }));
    expect(listStableProfileEntries(butlerData)).toContainEqual(expect.objectContaining({
      category: "relationships",
      facet: "collaboration_preferences",
      summary: "User expects the assistant to behave like a critical peer or capable collaborator rather than a passive helper.",
      sensitive_domain: false,
    }));
    expect(listStableProfileEntries(butlerData)).toContainEqual(expect.objectContaining({
      category: "boundaries",
      summary: "Sensitive imported health context should be treated as deep personalization context.",
      sensitive_domain: true,
    }));
    const manifestDir = join(butlerData, "personalization", "profile-imports");
    const manifestFiles = readdirSync(manifestDir);
    expect(manifestFiles).toHaveLength(1);
    const manifestText = readFileSync(join(manifestDir, manifestFiles[0]!), "utf8");
    expect(manifestText).toContain('"raw_text_included": false');
    expect(manifestText).toContain('"source": "chatgpt"');
    expect(manifestText).not.toContain("raw dump sentinel");
    expect(manifestText).not.toContain("붕괴 스타레일");
    const importedProjection = readRuntimeProfileProjection(butlerData);
    expect(importedProjection?.how_to_collaborate).toContain(
      "surface missed assumptions",
    );
    expect(importedProjection?.current_attention).not.toContain(
      "Currently tracks Honkai: Star Rail story and Butler personalization quality.",
    );
    const importedEntries = listStableProfileEntries(butlerData);
    expect(Object.values(importedEntries[0]!.evidence_observed_at)).toEqual([null]);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("basic profile migration filters strict sensitive imports while applying safe style preferences", async () => {
  const butlerData = join(tmpdir(), `butler-profile-${Date.now()}-${Math.random()}`);
  try {
    writeProfilingConsentSnapshot(butlerData, {
      mode: "basic",
      consented_at: "2026-05-17T00:00:00.000Z",
    });

    const imported = await importProfileCandidatesFromThirdPartyDumpWithModel(
      butlerData,
      {
        source: "external-ai",
        text: "profile import sentinel",
        now: new Date("2026-05-17T02:00:00.000Z"),
        modelRunner: async (input) => {
          expect(input.instructions).toContain("For basic mode");
          const evidenceRef = input.prompt.match(/Import ref: ([^\n]+)/u)?.[1] ?? "";
          return JSON.stringify({
            candidates: [
              {
                layer: "contextual_adaptation",
                category: "communication",
                facet: "tone_preference",
                summary: "User prefers concise, direct Korean explanations.",
                applies_when: ["answering"],
                butler_should: ["keep answers concise and direct"],
                butler_should_not: ["add filler"],
                temporal_scope: "durable",
                decay_policy: "reinforce_or_decay",
                source_type: "inference",
                confidence: "medium",
                evidence_refs: [evidenceRef],
                sensitive_domain: false,
                sensitivity: "normal",
                expires_or_decay: "decay",
              },
              {
                layer: "contextual_adaptation",
                category: "boundaries",
                facet: "sensitive_domains",
                summary: "User shared health treatment context.",
                applies_when: ["health_context"],
                butler_should: ["handle carefully"],
                butler_should_not: ["reuse casually"],
                temporal_scope: "durable",
                decay_policy: "never_without_consent",
                source_type: "inference",
                confidence: "high",
                evidence_refs: [evidenceRef],
                sensitive_domain: true,
                sensitivity: "sensitive",
                expires_or_decay: "decay",
              },
            ],
          });
        },
      },
    );

    expect(imported).toMatchObject({
      profiling_enabled: true,
      mode: "basic",
      imported_candidate_count: 2,
      promoted_count: 1,
      skipped_count: 1,
      raw_text_included: false,
    });
    expect(listStableProfileEntries(butlerData)).toContainEqual(expect.objectContaining({
      category: "communication",
      facet: "tone_preference",
      summary: "User prefers concise, direct Korean explanations.",
    }));
    expect(listStableProfileEntries(butlerData)).not.toContainEqual(expect.objectContaining({
      summary: "User shared health treatment context.",
    }));
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("free-form feedback profiling capture does not create heuristic candidates", () => {
  const butlerData = join(tmpdir(), `butler-profile-${Date.now()}-${Math.random()}`);
  try {
    const feedback = {
      feedback_id: "fb_profile_1",
      category: "style",
      promotion_target: "profile_candidate",
      target_ref: "style:butler/main",
      text: "고쳤다고 말하기 전에 재현하고 검증해줘. 원시 툴 페이로드나 내부 프롬프트는 답변에 노출하지 마.",
      privacy_class: "private",
    };

    expect(captureProfileCandidatesFromFeedback(butlerData, feedback)).toEqual([]);

    writeProfilingConsentSnapshot(butlerData, { mode: "basic" });
    const candidates = captureProfileCandidatesFromFeedback(butlerData, feedback);
    expect(candidates).toEqual([]);
    expect(JSON.stringify(candidates)).not.toContain(feedback.text);
    expect(listProfileCandidates(butlerData)).toEqual([]);

    const result = consolidateProfileCandidates(butlerData);
    expect(result).toMatchObject({
      profiling_enabled: true,
      mode: "basic",
      raw_text_included: false,
      projection_written: false,
    });
    expect(result.promoted_count).toBe(0);
    expect(listStableProfileEntries(butlerData)).toEqual([]);

    const projection = readRuntimeProfileProjection(butlerData);
    expect(projection).toBeNull();
    expect(renderRuntimeProfileProjectionPrompt(projection) ?? "").not.toContain(feedback.text);

    const reflective = readReflectiveProfileSummary(butlerData, "ko");
    expect(reflective.raw_profile_included).toBe(false);
    expect(reflective.bullets).toEqual([]);

    const cleared = clearProfilingData(butlerData);
    expect(cleared.removed_stable_entries).toBe(0);
    expect(readRuntimeProfileProjection(butlerData)).toBeNull();
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("canonical scalar coverage preserves exact multilingual windows and resumes a failed normal cycle", async () => {
  const butlerData = join(tmpdir(), `butler-profile-${Date.now()}-${Math.random()}`);
  try {
    writeProfilingConsentSnapshot(butlerData, {
      mode: "deep",
      consented_at: "2026-09-01T00:00:00.000Z",
    });
    const longScalar = `${"가나다🙂  줄바꿈\n".repeat(900)}결정적 꼬리: 원문 그대로 보존`;
    const secondScalar = "Second scalar: preserve exact spacing   and accents e\u0301.";
    const escapingScalar = `${"\u0001".repeat(9_000)}escaping-tail`;
    const store = new AgentConversationStore({ butlerData });
    try {
      const turn = store.beginTurn({
        gateway: "app",
        externalSessionId: "coverage",
        sessionId: "cs_profile_coverage",
        actor: "user",
        now: "2026-09-01T00:00:00.000Z",
      });
      store.appendUserMessage({
        sessionId: "cs_profile_coverage",
        turnId: turn.id,
        messageId: "cm_profile_coverage",
        text: "",
        originKind: "user_input",
        now: "2026-09-01T00:01:00.000Z",
        parts: [{
          kind: "message_content",
          contentJson: [
            { type: "text", text: longScalar },
            { type: "text", text: secondScalar },
            { type: "text", text: escapingScalar },
          ],
        }],
      });
      store.appendUserMessage({
        sessionId: "cs_profile_coverage",
        turnId: turn.id,
        messageId: "cm_internal_profile",
        text: "internal text must never reach profiling",
        originKind: "internal_control",
        now: "2026-09-01T00:02:00.000Z",
      });
    } finally {
      store.close();
    }

    const delivered: Array<{ ref: string; text: string; bytes: number }> = [];
    let calls = 0;
    const runner = async (input: { prompt: string }) => {
      calls += 1;
      const bytes = Buffer.byteLength(input.prompt);
      expect(bytes).toBeLessThanOrEqual(24 * 1024);
      const prompt = JSON.parse(input.prompt) as {
        observations: Array<{ ref: string; text: string }>;
      };
      const observation = prompt.observations[0]!;
      delivered.push(...prompt.observations.map((item) => ({ ...item, bytes })));
      expect(prompt.observations.every((item) => !item.text.includes("internal text"))).toBe(true);
      if (calls === 1) expect(prompt.observations.length).toBeGreaterThan(1);
      if (calls === 1) {
        return {
          text: JSON.stringify({
            candidates: [{
              category: "cares",
              facet: "current_interests",
              summary: "Values exact multilingual source preservation.",
              source_type: "explicit",
              confidence: "high",
              evidence_refs: [observation.ref],
              temporal_scope: "active",
              decay_policy: "days_30",
              sensitive_domain: false,
            }],
          }),
          usage: {
            model: "openai/gpt-5.6-sol",
            promptTokens: 100,
            cachedTokens: 20,
            outputTokens: 25,
            totalTokens: 125,
          },
        };
      }
      if (calls === 2) {
        return JSON.stringify({ candidates: [{
          category: "cares",
          summary: "Ungrounded candidate must fail the delivered window.",
          source_type: "explicit",
          confidence: "high",
          evidence_refs: ["profile_window:not-delivered"],
        }] });
      }
      return JSON.stringify({ candidates: [] });
    };

    const first = await runCognitionConsolidationCycle({
      butlerData,
      runId: "cr_profile_coverage",
      profileExtractorModelRunner: runner,
    });
    expect(first.status).toBe("completed_with_errors");
    expect(first.phases.find((phase) => phase.phase === "profile_consolidation")).toMatchObject({
      status: "error",
      metrics: {
        semantic_captured_candidate_count: 1,
        transcript_extractor_model_called: true,
        model_usage: { request_count: 2, prompt_tokens: 100, total_tokens: 125 },
      },
    });
    expect(listStableProfileEntries(butlerData)).toContainEqual(expect.objectContaining({
      summary: "Values exact multilingual source preservation.",
    }));
    const firstRefs = delivered.map((item) => item.ref);

    const resumed = await runCognitionConsolidationCycle({
      butlerData,
      runId: "cr_profile_coverage",
      resume: true,
      profileExtractorModelRunner: runner,
    });
    expect(resumed.status).toBe("completed");
    expect(resumed.phases.map((phase) => phase.phase)).toEqual(["profile_consolidation"]);
    expect(delivered.slice(firstRefs.length).every((item) => item.ref !== firstRefs[0])).toBe(true);
    expect([...new Map(delivered.map((item) => [item.ref, item.text])).values()].join(""))
      .toBe(longScalar + secondScalar + escapingScalar);

    const db = new Database(profileBlackBoxPath(butlerData), { readonly: true });
    try {
      const rows = db.query(`
        SELECT disposition, failure_code, message_id, source_hash, part_id,
               scalar_pointer, byte_start, byte_end, extractor_version, observed_at
        FROM profile_source_coverage
        ORDER BY observed_at, part_id, byte_start
      `).all() as Array<Record<string, unknown>>;
      expect(rows.length).toBe(new Set(delivered.map((item) => item.ref)).size);
      expect(rows.every((row) => row.disposition === "complete")).toBe(true);
      expect(rows.every((row) => row.message_id === "cm_profile_coverage")).toBe(true);
      expect(rows.every((row) => typeof row.source_hash === "string" && row.extractor_version === "profile-scalar-v1"))
        .toBe(true);
    } finally {
      db.close();
    }
    const boundedStore = new AgentConversationStore({ butlerData });
    try {
      const turn = boundedStore.beginTurn({
        gateway: "app", externalSessionId: "bounded", sessionId: "cs_profile_coverage", actor: "user",
        now: "2026-09-01T00:03:00.000Z",
      });
      for (let index = 0; index < 3; index += 1) {
        boundedStore.appendUserMessage({
          sessionId: "cs_profile_coverage", turnId: turn.id, messageId: `cm_profile_bounded_${index}`,
          text: `bounded profile observation ${index}`, originKind: "user_input",
          now: `2026-09-01T00:0${index + 4}:00.000Z`,
        });
      }
    } finally {
      boundedStore.close();
    }
    const boundedFirst = await captureProfileCandidatesFromTranscriptsWithModel(butlerData, {
      modelRunner: runner, maxUserMessages: 1, maxModelBatches: 1,
    });
    expect(boundedFirst.model_error).toBe("profile source discovery remains unfinished");
    let boundedFinal = boundedFirst;
    let boundedAttempts = 0;
    for (; boundedAttempts < 20 && boundedFinal.model_error; boundedAttempts += 1) {
      boundedFinal = await captureProfileCandidatesFromTranscriptsWithModel(butlerData, {
        modelRunner: runner, maxUserMessages: 1, maxModelBatches: 1,
      });
    }
    expect(boundedFinal.model_error).toBeUndefined();
    expect(boundedAttempts).toBeLessThan(20);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("source-observed expiry, promoted refresh, correction, and consent govern one short projection", async () => {
  const butlerData = join(tmpdir(), `butler-profile-${Date.now()}-${Math.random()}`);
  const recentAt = new Date(Date.now() - 86_400_000).toISOString();
  const oldAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
  try {
    writeProfilingConsentSnapshot(butlerData, { mode: "deep", consented_at: oldAt });
    writeConversationProfileMessages(butlerData, [
      { id: "recent_rule", timestamp: recentAt, text: "Always give me concise verified answers." },
      { id: "old_interest", timestamp: oldAt, text: "I am briefly interested in an expired topic." },
      { id: "old_temporary", timestamp: oldAt, text: "Temporarily prefer energetic answers." },
      { id: "recent_temporary", timestamp: recentAt, text: "Temporarily prefer energetic answers." },
    ]);
    let refreshOfferedTarget: (() => void) | null = null;
    const modelRunner = async (input: { prompt: string }) => {
      const prompt = JSON.parse(input.prompt) as {
        observations: Array<{ ref: string; text: string }>;
        correction_targets: Array<{ target_ref: string; instruction: string }>;
      };
      const candidates = prompt.observations.map((observation) => {
        if (observation.text.includes("energetic answers")) return {
          category: "communication" as const,
          facet: "tone_preference" as const,
          summary: "Temporarily prefers energetic answers.",
          butler_should: ["Use an energetic tone."],
          applies_when: ["answering"],
          temporal_scope: "transient" as const,
          decay_policy: "days_7" as const,
          source_type: "explicit" as const,
          confidence: "high" as const,
          evidence_refs: [observation.ref],
        };
        if (observation.text.includes("expired topic")) return {
          category: "cares",
          facet: "current_interests",
          summary: "An expired short-lived topic.",
          butler_should: ["Mention the expired topic."],
          applies_when: ["answering"],
          temporal_scope: "transient",
          decay_policy: "days_7",
          source_type: "explicit",
          confidence: "high",
          evidence_refs: [observation.ref],
        };
        if (observation.text.includes("Do not be concise")) {
          const target = prompt.correction_targets.find((item) => item.instruction === "Answer concisely and verify claims.");
          expect(target).toBeDefined();
          refreshOfferedTarget?.();
          refreshOfferedTarget = null;
          return {
          category: "communication",
          facet: "explanation_preference",
          summary: "Prefers detailed verified answers now.",
          butler_should: ["Answer with useful detail and verify claims."],
          applies_when: ["answering"],
          temporal_scope: "durable",
          decay_policy: "days_30",
          source_type: "explicit",
          confidence: "high",
          evidence_refs: [observation.ref],
            contradiction_refs: [target!.target_ref],
          };
        }
        return {
        category: "communication",
        facet: "explanation_preference",
        summary: "Prefers concise verified answers.",
        butler_should: ["Answer concisely and verify claims."],
        applies_when: ["answering"],
        temporal_scope: "durable",
        decay_policy: "days_30",
        source_type: "explicit",
        confidence: "high",
          evidence_refs: [observation.ref],
        };
      });
      return JSON.stringify({ candidates });
    };

    await captureProfileCandidatesFromTranscriptsWithModel(butlerData, { modelRunner });
    consolidateProfileCandidates(butlerData);
    const initial = listStableProfileEntries(butlerData)
      .find((entry) => entry.summary === "Prefers concise verified answers.")!;
    const initialCandidate = listProfileCandidates(butlerData)
      .find((entry) => entry.summary === "Prefers concise verified answers.")!;
    expect(initial.evidence_count).toBe(1);
    const replay = await captureProfileCandidatesFromTranscriptsWithModel(butlerData, { modelRunner });
    expect(replay.model_called).toBe(false);
    expect(listStableProfileEntries(butlerData).find((entry) => entry.id === initial.id)).toMatchObject({
      evidence_count: 1,
      evidence_observed_at: initial.evidence_observed_at,
      updated_at: initial.updated_at,
    });
    expect(listProfileCandidates(butlerData).find((entry) => entry.id === initialCandidate.id)).toMatchObject({
      evidence_count: 1,
      last_seen_at: initialCandidate.last_seen_at,
      updated_at: initialCandidate.updated_at,
    });

    const store = new AgentConversationStore({ butlerData });
    try {
      const refreshTurn = store.beginTurn({
        gateway: "app", externalSessionId: "refresh", sessionId: "cs_profile", actor: "user",
        turnId: "ct_profile_refresh", now: new Date().toISOString(),
      });
      store.appendUserMessage({
        sessionId: "cs_profile", turnId: refreshTurn.id, messageId: "cm_profile_refresh",
        text: "Always give me concise verified answers.", originKind: "user_input", now: new Date().toISOString(),
      });
    } finally {
      store.close();
    }
    await captureProfileCandidatesFromTranscriptsWithModel(butlerData, { modelRunner });
    const refreshed = listStableProfileEntries(butlerData).find((entry) => entry.id === initial.id)!;
    expect(refreshed.evidence_count).toBe(2);
    expect(Object.values(refreshed.evidence_observed_at).filter(Boolean)).toHaveLength(2);
    let projection = readRuntimeProfileProjection(butlerData);
    expect(projection?.how_to_answer).toContain("Answer concisely and verify claims.");
    expect(projection?.how_to_answer).toContain("Use an energetic tone.");
    expect(projection?.current_attention).not.toContain("An expired short-lived topic.");
    const conversationDb = new Database(conversationStorePath(butlerData));
    try {
      conversationDb.query(`
        UPDATE conversation_parts
        SET content_json=?
        WHERE message_id='cm_recent_temporary' AND kind='text'
      `).run(JSON.stringify({ text: "Changed source no longer supports that preference." }));
    } finally {
      conversationDb.close();
    }
    projection = readRuntimeProfileProjection(butlerData);
    expect(projection?.how_to_answer).not.toContain("Use an energetic tone.");
    refreshOfferedTarget = () => {
      upsertProfileCandidate(butlerData, {
        category: "communication",
        facet: "explanation_preference",
        summary: "Prefers concise verified answers.",
        applies_when: ["answering"],
        butler_should: ["Answer concisely, verify claims, and name uncertainty."],
        temporal_scope: "durable",
        decay_policy: "days_30",
        source_type: "explicit",
        confidence: "high",
        evidence_ref: refreshed.evidence_refs[0],
        evidence_observed_at: refreshed.evidence_observed_at[refreshed.evidence_refs[0]!],
      });
    };

    const correctionStore = new AgentConversationStore({ butlerData });
    try {
      const correctionTurn = correctionStore.beginTurn({
        gateway: "app", externalSessionId: "correction", sessionId: "cs_profile", actor: "user",
        turnId: "ct_profile_correction", now: new Date().toISOString(),
      });
      correctionStore.appendUserMessage({
        sessionId: "cs_profile", turnId: correctionTurn.id, messageId: "cm_profile_correction",
        text: "Do not be concise anymore; give useful detail, but keep verification.",
        originKind: "user_input", now: new Date().toISOString(),
      });
    } finally {
      correctionStore.close();
    }
    const staleCorrection = await captureProfileCandidatesFromTranscriptsWithModel(butlerData, { modelRunner });
    expect(staleCorrection.model_error).toBe("profile correction target changed");
    expect(readRuntimeProfileProjection(butlerData)?.how_to_answer).not.toContain(
      "Answer with useful detail and verify claims.",
    );
    await captureProfileCandidatesFromTranscriptsWithModel(butlerData, { modelRunner });
    consolidateProfileCandidates(butlerData);
    projection = readRuntimeProfileProjection(butlerData);
    expect(projection?.how_to_answer).toContain("Answer with useful detail and verify claims.");
    expect(projection?.how_to_answer).not.toContain("Answer concisely and verify claims.");

    const refCapStore = new AgentConversationStore({ butlerData });
    try {
      const boundaryTurn = refCapStore.beginTurn({
        gateway: "app", externalSessionId: "ref-cap-boundary", sessionId: "cs_profile", actor: "user",
        now: new Date().toISOString(),
      });
      refCapStore.appendUserMessage({
        sessionId: "cs_profile", turnId: boundaryTurn.id, messageId: "cm_ref_cap_boundary",
        text: "Always keep private profile details out of answers.", originKind: "user_input",
        now: new Date().toISOString(),
      });
    } finally {
      refCapStore.close();
    }
    await captureProfileCandidatesFromTranscriptsWithModel(butlerData, {
      modelRunner: async (input) => {
        const prompt = JSON.parse(input.prompt) as { observations: Array<{ ref: string }> };
        return JSON.stringify({ candidates: [{
          category: "boundaries",
          facet: "privacy_rules",
          summary: "Always keep private profile details out of answers.",
          butler_should_not: ["Expose private profile details."],
          temporal_scope: "durable",
          decay_policy: "reinforce_or_decay",
          source_type: "explicit",
          confidence: "high",
          evidence_refs: [prompt.observations[0]!.ref],
        }] });
      },
    });
    consolidateProfileCandidates(butlerData);

    for (let round = 0; round < 2; round += 1) {
      const crowdStore = new AgentConversationStore({ butlerData });
      try {
        const crowdTurn = crowdStore.beginTurn({
          gateway: "app", externalSessionId: `ref-cap-crowd-${round}`, sessionId: "cs_profile", actor: "user",
          now: new Date().toISOString(),
        });
        for (let index = 0; index < 12; index += 1) {
          const sourceIndex = round * 12 + index;
          crowdStore.appendUserMessage({
            sessionId: "cs_profile", turnId: crowdTurn.id, messageId: `cm_ref_cap_crowd_${sourceIndex}`,
            text: `Repeated collaboration evidence ${sourceIndex}.`, originKind: "user_input",
            now: new Date().toISOString(),
          });
        }
      } finally {
        crowdStore.close();
      }
      await captureProfileCandidatesFromTranscriptsWithModel(butlerData, {
        modelRunner: async (input) => {
          const prompt = JSON.parse(input.prompt) as { observations: Array<{ ref: string }> };
          expect(prompt.observations).toHaveLength(12);
          return JSON.stringify({ candidates: [{
            category: "communication",
            facet: "explanation_preference",
            summary: "Prefers accumulated collaboration evidence.",
            butler_should: ["Accumulate collaboration evidence."],
            temporal_scope: "durable",
            decay_policy: "reinforce_or_decay",
            source_type: "repeated_observation",
            confidence: "high",
            evidence_refs: prompt.observations.map((observation) => observation.ref),
          }] });
        },
      });
      consolidateProfileCandidates(butlerData);
    }
    const refCapEntries = listStableProfileEntries(butlerData);
    const crowdEntry = refCapEntries.find((entry) =>
      entry.summary === "Prefers accumulated collaboration evidence.")!;
    const boundaryEntry = refCapEntries.find((entry) =>
      entry.summary === "Always keep private profile details out of answers.")!;
    expect(crowdEntry.evidence_refs).toHaveLength(24);
    expect(refCapEntries.indexOf(crowdEntry)).toBeLessThan(refCapEntries.indexOf(boundaryEntry));
    const relevantRefOrder = refCapEntries.flatMap((entry) => entry.evidence_refs);
    expect(relevantRefOrder.indexOf(boundaryEntry.evidence_refs[0]!)).toBeGreaterThanOrEqual(24);
    projection = readRuntimeProfileProjection(butlerData);
    expect(projection?.active_boundaries).toContain("Always keep private profile details out of answers.");

    const concurrencyStore = new AgentConversationStore({ butlerData });
    try {
      const turn = concurrencyStore.beginTurn({
        gateway: "app", externalSessionId: "profile-owner-concurrency", sessionId: "cs_profile", actor: "user",
        now: new Date().toISOString(),
      });
      concurrencyStore.appendUserMessage({
        sessionId: "cs_profile", turnId: turn.id, messageId: "cm_profile_owner_concurrency",
        text: "Keep profile extraction single-owner while work is in flight.", originKind: "user_input",
        now: new Date().toISOString(),
      });
    } finally { concurrencyStore.close(); }
    let enterModel!: () => void;
    let releaseModel!: () => void;
    const modelEntered = new Promise<void>((resolve) => { enterModel = resolve; });
    const modelBlocked = new Promise<void>((resolve) => { releaseModel = resolve; });
    const concurrentRunner = async (input: { prompt: string }) => {
      const lease = acquireConsolidationLock(consolidationLockPath(butlerData), { purpose: "profile_model_probe" });
      expect(lease).not.toBeNull();
      releaseConsolidationLock(consolidationLockPath(butlerData), lease!);
      enterModel();
      await modelBlocked;
      const prompt = JSON.parse(input.prompt) as { observations: Array<{ ref: string }> };
      return JSON.stringify({ candidates: [{
        category: "communication",
        facet: "collaboration_preferences",
        summary: "Prefers collaboration that keeps profile extraction single-owner.",
        butler_should: ["Keep profile extraction single-owner while collaborating."],
        temporal_scope: "durable",
        decay_policy: "reinforce_or_decay",
        source_type: "explicit",
        confidence: "high",
        evidence_refs: [prompt.observations[0]!.ref],
      }] });
    };
    const firstOwner = captureProfileCandidatesFromTranscriptsWithModel(butlerData, { modelRunner: concurrentRunner });
    await modelEntered;
    let duplicateOwner: Awaited<ReturnType<typeof captureProfileCandidatesFromTranscriptsWithModel>>;
    try {
      duplicateOwner = await captureProfileCandidatesFromTranscriptsWithModel(butlerData, { modelRunner: concurrentRunner });
    } finally { releaseModel(); }
    expect(duplicateOwner).toMatchObject({
      model_called: false,
      model_error: "profile source is already being processed",
    });
    expect(await firstOwner).toMatchObject({ model_called: true, captured_candidate_count: 1 });

    writeProfilingConsentSnapshot(butlerData, { mode: "off" });
    let callsAfterConsent = 0;
    const off = await captureProfileCandidatesFromTranscriptsWithModel(butlerData, {
      modelRunner: async () => {
        callsAfterConsent += 1;
        return JSON.stringify({ candidates: [] });
      },
    });
    expect(off.model_called).toBe(false);
    expect(callsAfterConsent).toBe(0);
    expect(readRuntimeProfileProjection(butlerData)).toBeNull();
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
