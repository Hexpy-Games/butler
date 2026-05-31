import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createBoxItem, readBoxManifest } from "../../packages/butler-agent/src/agent/cognition/box/store.ts";
import { runCognitionConsolidationCycle, readConsolidationCheckpoint } from "../../packages/butler-agent/src/agent/cognition/consolidation/cycle.ts";
import { addFeedbackEntry, readFeedbackEntry } from "../../packages/butler-agent/src/agent/cognition/feedback/buffer.ts";
import { createKnowHowEntry, recordSourceQualityEvent, readKnowHowEntry } from "../../packages/butler-agent/src/agent/cognition/know-how/store.ts";
import { createMemoryChunk } from "../../packages/butler-agent/src/agent/cognition/memory/metadata.ts";
import { consolidationLockPath } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/lib/lock.ts";
import {
  readRuntimeProfileProjection,
  writeProfilingConsentSnapshot,
} from "../../packages/butler-agent/src/personalization/profiling.ts";
import { appendPromptCacheMetric } from "../../packages/butler-agent/src/integrations/providers/prompt-cache-metrics.ts";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import type { ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

function tempData(): string {
  return mkdtempSync(join(tmpdir(), "butler-consolidation-cycle-"));
}

const fakeProvider: ModelProviderAdapter = {
  id: "fake-openai",
  capabilities: {
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsImages: false,
    supportsAudio: false,
    supportsServerThreads: false,
    supportsReasoningConfig: true,
    supportsPromptCaching: true,
  },
  async invoke() {
    return { text: "unused" };
  },
};

test("consolidation cycle runs all cognition phases with raw-text-free summaries", async () => {
  const butlerData = tempData();
  try {
    const box = createBoxItem(butlerData, {
      kind: "source_snapshot",
      title: "Weather evidence",
      summary: "Weather source summary.",
      origin: { producer: "unit-test" },
      content: [{ filename: "payload.json", data: "PRIVATE_BOX_RAW", mimeType: "application/json" }],
    });
    const feedback = addFeedbackEntry(butlerData, {
      text: "이제 bad-source는 쓰지 마세요.",
      targetRef: "source:bad-source",
      category: "source_policy",
      promotionTarget: "source_quality",
    });
    const knowhow = createKnowHowEntry(butlerData, {
      name: "weather_source_lookup",
      aliases: ["weather"],
      status: "active",
      summary: "Use source.",
      intent_match: { topics: ["weather"], examples: ["weather now"] },
      strategy: { steps: ["fetch"], preferred_sources: ["bad-source"] },
      refs: { box_item_ids: [box.box_item_id], memory_chunk_ids: [], feedback_ids: [], consolidation_run_ids: [] },
      quality: {
        score: 0.8,
        confidence: 0.8,
        success_count: 2,
        failure_count: 0,
        negative_feedback_count: 0,
        last_used_at: null,
        last_validated_at: null,
      },
    });
    createMemoryChunk(butlerData, {
      scope: "global",
      summary: "Box evidence summary.",
      source: "unit-test",
      boxRefs: [{ box_item_id: box.box_item_id, relation: "evidence" }],
      feedbackRefs: [{ feedback_id: feedback.feedback_id, relation: "user_feedback" }],
    });
    recordSourceQualityEvent(butlerData, {
      source_id: "bad-source",
      source_uri: "https://bad.example.test",
      tool_name: "weather",
      observed_at: "2026-05-15T00:00:00.000Z",
      task_kind: "weather",
      freshness_score: 0.2,
      success: false,
      latency_ms: 900,
      user_feedback: "negative",
      box_item_id: box.box_item_id,
      feedback_id: feedback.feedback_id,
      consolidation_run_id: null,
    });

    const result = await runCognitionConsolidationCycle({ butlerData, runId: "cr_test" });
    expect(result.status).toBe("completed");
    expect(result.raw_text_included).toBe(false);
    expect(result.phases.map((phase) => phase.phase)).toEqual([
      "preflight",
      "feedback_triage",
      "profile_consolidation",
      "new_chat_briefing",
      "box_index",
      "memory_metadata_integrity",
      "source_quality_aggregation",
      "knowhow_revision",
      "memory_health",
      "box_retention",
      "metrics_summary",
    ]);
    expect(readFeedbackEntry(butlerData, feedback.feedback_id)?.status).toBe("applied");
    expect(readKnowHowEntry(butlerData, knowhow.knowhow_id)?.status).toBe("disabled");
    expect(readFileSync(result.summary_path, "utf8")).not.toContain("PRIVATE_BOX_RAW");
    expect(existsSync(join(butlerData, "cognition", "box", "index.sqlite"))).toBe(true);
    expect(existsSync(join(butlerData, "cognition", "know-how", "index.sqlite"))).toBe(true);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("consolidation cycle defers before heavy work when provider budget is below ten percent", async () => {
  const butlerData = tempData();
  try {
    const result = await runCognitionConsolidationCycle({
      butlerData,
      runId: "cr_defer",
      rateLimitBudget: () => ({ remainingRatio: 0.05, resetAt: "2026-05-15T01:00:00.000Z" }),
    });
    expect(result.status).toBe("deferred_rate_limited");
    expect(result.phases).toHaveLength(1);
    expect(existsSync(join(butlerData, "cognition", "box", "index.sqlite"))).toBe(false);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("consolidation cycle does not promote free-form profile feedback heuristically", async () => {
  const butlerData = tempData();
  try {
    writeProfilingConsentSnapshot(butlerData, { mode: "basic" });
    const feedback = addFeedbackEntry(butlerData, {
      text: "앞으로 고쳤다고 말하기 전에 재현하고 검증한 내용을 말해줘.",
      targetRef: "style:butler/main",
      category: "style",
      promotionTarget: "profile_candidate",
    });

    const result = await runCognitionConsolidationCycle({
      butlerData,
      runId: "cr_profile",
    });

    expect(result.status).toBe("completed");
    const profilePhase = result.phases.find((phase) => phase.phase === "profile_consolidation");
    expect(profilePhase?.metrics).toMatchObject({
      profiling_enabled: true,
      applied_feedback_count: 0,
      projection_written: false,
      raw_text_included: false,
    });
    expect(readFeedbackEntry(butlerData, feedback.feedback_id)?.status).toBe("active");
    expect(readRuntimeProfileProjection(butlerData)).toBeNull();
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("consolidation cycle extracts profile candidates from consented transcripts", async () => {
  const butlerData = tempData();
  try {
    writeProfilingConsentSnapshot(butlerData, {
      mode: "deep",
      consented_at: "2026-05-17T00:00:00.000Z",
    });
    const transcriptDir = join(butlerData, "transcripts");
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(join(transcriptDir, "butler_app-general.jsonl"), [
      transcriptEvent("evt_t1", "2026-05-17T00:01:00.000Z", "버틀러는 워커 오케스트레이션과 프로파일링이 실제로 작동하는지 검증해야 해."),
      transcriptEvent("evt_t2", "2026-05-17T00:02:00.000Z", "고쳤다고 말하기 전에 재현하고 확인까지 해야 해. 임시방편 말고 구조적으로 고쳐."),
      transcriptEvent("evt_t3", "2026-05-17T00:03:00.000Z", "프로파일링은 동의 기반 로컬 블랙박스로 두고 원시 로그는 노출하지 마."),
    ].join("\n") + "\n", "utf8");

    const result = await runCognitionConsolidationCycle({
      butlerData,
      runId: "cr_profile_transcript",
      profileExtractorModelRunner: async () => JSON.stringify({
        candidates: [
          {
            category: "cares",
            summary: "Currently cares about making Butler orchestration and profiling work in real use.",
            source_type: "repeated_observation",
            confidence: "medium",
            evidence_refs: [
              "transcript:butler_app-general:evt_t1",
              "transcript:butler_app-general:evt_t2",
            ],
            sensitive_domain: false,
            expires_or_decay: "decay",
          },
          {
            category: "boundaries",
            summary: "Treat profiling as consent-gated local black-box data and avoid raw log exposure.",
            source_type: "explicit",
            confidence: "high",
            evidence_refs: ["transcript:butler_app-general:evt_t3"],
            sensitive_domain: false,
            expires_or_decay: "decay",
          },
        ],
      }),
    });

    expect(result.status).toBe("completed");
    const profilePhase = result.phases.find((phase) => phase.phase === "profile_consolidation");
    expect(profilePhase?.metrics).toMatchObject({
      profiling_enabled: true,
      transcript_scanned_file_count: 1,
      transcript_scanned_event_count: 3,
      transcript_extractor_model_called: true,
      transcript_extractor_fallback_used: false,
      projection_written: true,
      raw_text_included: false,
    });
    expect(Number(profilePhase?.metrics.transcript_captured_candidate_count)).toBe(2);
    expect(readRuntimeProfileProjection(butlerData)?.current_attention.join(" ")).toContain("Butler");
    expect(readFileSync(result.summary_path, "utf8")).not.toContain("원시 로그는 노출하지 마");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("profile consolidation uses the previous completed run as transcript watermark", async () => {
  const butlerData = tempData();
  try {
    writeProfilingConsentSnapshot(butlerData, {
      mode: "deep",
      consented_at: "2026-05-17T00:00:00.000Z",
    });
    const transcriptDir = join(butlerData, "transcripts");
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(join(transcriptDir, "butler_app-general.jsonl"), [
      transcriptEvent("evt_old", "2026-05-28T19:00:00.000Z", "OLD_PROFILE_TEXT should not be reprocessed."),
      transcriptEvent("evt_new", "2026-05-28T19:07:00.000Z", "NEW_PROFILE_TEXT should be extracted."),
    ].join("\n") + "\n", "utf8");
    const runsDir = join(butlerData, "cognition", "consolidation", "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "cr_previous.json"), JSON.stringify({
      run_id: "cr_previous",
      status: "completed",
      completed_at: "2026-05-28T19:06:50.238Z",
      phases: [{ phase: "profile_consolidation", status: "ok", metrics: { raw_text_included: false } }],
      raw_text_included: false,
    }), "utf8");

    const prompts: string[] = [];
    const result = await runCognitionConsolidationCycle({
      butlerData,
      runId: "cr_incremental_profile",
      profileExtractorModelRunner: async (input) => {
        prompts.push(input.prompt);
        expect(input.prompt).not.toContain("OLD_PROFILE_TEXT");
        expect(input.prompt).toContain("NEW_PROFILE_TEXT");
        return JSON.stringify({
          candidates: [{
            category: "cares",
            summary: "Currently cares about the new profile text.",
            source_type: "explicit",
            confidence: "high",
            evidence_refs: ["transcript:butler_app-general:evt_new"],
            sensitive_domain: false,
            expires_or_decay: "decay",
          }],
        });
      },
    });

    expect(result.status).toBe("completed");
    expect(prompts).toHaveLength(1);
    const profilePhase = result.phases.find((phase) => phase.phase === "profile_consolidation");
    expect(profilePhase?.metrics).toMatchObject({
      transcript_since: "2026-05-28T19:06:50.238Z",
      transcript_scanned_event_count: 1,
      transcript_captured_candidate_count: 1,
      transcript_extractor_model_called: true,
      raw_text_included: false,
    });
    expect(readRuntimeProfileProjection(butlerData)?.current_attention.join(" ")).toContain("new profile text");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("consolidation cycle writes generated new chat briefing artifacts and usage report", async () => {
  const butlerData = tempData();
  try {
    const projectDir = join(butlerData, "project-ledger", "projects", "butler");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "project.json"),
      JSON.stringify({
        schema: "project-ledger.project.v1",
        id: "butler",
        name: "Butler",
        status: "active",
      }),
      "utf8",
    );
    writeFileSync(
      join(projectDir, "ledger.jsonl"),
      [
        JSON.stringify({ type: "work_written", kind: "work", status: "active" }),
        JSON.stringify({ type: "view_rendered", kind: "dashboard", status: "ok" }),
      ].join("\n") + "\n",
      "utf8",
    );
    mkdirSync(join(butlerData, "personas"), { recursive: true });
    writeFileSync(
      join(butlerData, "personas", "active.md"),
      "# Butler Persona\n\nUse concise, calm product copy.",
      "utf8",
    );
    writeProfilingConsentSnapshot(butlerData, {
      mode: "deep",
      consented_at: "2026-05-28T00:00:00.000Z",
    });
    const transcriptDir = join(butlerData, "transcripts");
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(join(transcriptDir, "butler_app-general.jsonl"), [
      transcriptEvent("evt_topic", "2026-05-28T00:01:00.000Z", "충주 냉면과 저녁에 볼 anime 추천도 궁금해."),
    ].join("\n") + "\n", "utf8");

    const result = await runCognitionConsolidationCycle({
      butlerData,
      runId: "cr_briefing",
      now: new Date("2026-05-28T19:06:50.238Z"),
      profileExtractorModelRunner: async () => JSON.stringify({
        candidates: [
          {
            category: "cares",
            summary: "The user is currently asking about 충주 냉면 and anime recommendations.",
            source_type: "explicit",
            confidence: "high",
            evidence_refs: ["transcript:butler_app-general:evt_topic"],
            sensitive_domain: false,
            expires_or_decay: "decay",
          },
        ],
      }),
      newChatBriefingModelRunner: async (input) => {
        const project = input.prompt.includes("project_new_chat_briefing");
        if (project) {
          expect(input.prompt).not.toContain("충주 냉면");
          expect(input.prompt).not.toContain("anime recommendations");
          expect(input.prompt).not.toContain("title_variants");
        } else {
          expect(input.prompt).toContain("title_variants");
        }
        expect(input.instructions).toContain("morning, afternoon, evening, and night");
        return {
          model: input.model,
          usage: {
            model: input.model,
            promptTokens: project ? 200 : 100,
            cachedTokens: project ? 50 : 25,
            totalTokens: project ? 260 : 140,
          },
          text: JSON.stringify({
            moment: project ? "Project" : "7:06 PM",
            title: project ? "Which Butler thread should we open?" : "What should we open today?",
            ...(project
              ? {}
              : {
                  title_variants: {
                    morning: "What should we open this morning?",
                    afternoon: "What should we open this afternoon?",
                    evening: "What should we open this evening?",
                    night: "What should we open tonight?",
                  },
                }),
            description: project
              ? "A few Butler project threads are ready."
              : "A few starting points are ready.",
            suggestions: [
              {
                id: "one",
                title: project ? "Project status" : "Open source getting attention",
                description: "This gives the next conversation a useful base.",
                text: "Open this topic.",
                source_kind: project ? "project_status" : "current_interest",
              },
              {
                id: "two",
                title: "Decision check",
                description: "This narrows what should be decided next.",
                text: "Check the decision.",
                source_kind: project ? "project_decision" : "adjacent_direction",
              },
              {
                id: "three",
                title: "Quality risk",
                description: "This keeps fragile work visible before continuing.",
                text: "Review quality risk.",
                source_kind: project ? "project_quality_risk" : "unfinished_topic",
              },
              {
                id: "four",
                title: "Next step",
                description: "This turns loose notes into a small start.",
                text: "Find the next step.",
                source_kind: project ? "project_next_step" : "timely_context",
              },
            ],
          }),
        };
      },
    });

    expect(result.status).toBe("completed");
    const briefingPhase = result.phases.find((phase) => phase.phase === "new_chat_briefing");
    expect(briefingPhase?.metrics).toMatchObject({
      generated_count: 2,
      failed_count: 0,
      raw_text_included: false,
      model_usage: {
        request_count: 2,
        prompt_tokens: 300,
        cached_input_tokens: 75,
        uncached_input_tokens: 225,
        output_tokens: 100,
        total_tokens: 400,
      },
    });
    expect(result.usage).toMatchObject({
      request_count: 3,
      prompt_tokens: 300,
      cached_input_tokens: 75,
      uncached_input_tokens: 225,
      output_tokens: 100,
      total_tokens: 400,
      raw_text_included: false,
    });
    const usagePhase = result.usage.phases.find((phase) => phase.phase === "new_chat_briefing");
    expect(usagePhase).toMatchObject({
      request_count: 2,
      prompt_tokens: 300,
      estimated_codex_5_5_credits: expect.any(Number),
    });

    const general = JSON.parse(
      readFileSync(join(butlerData, "cognition", "consolidation", "briefings", "2026-05-28", "general.json"), "utf8"),
    );
    const project = JSON.parse(
      readFileSync(join(butlerData, "cognition", "consolidation", "briefings", "2026-05-28", "projects", "butler.json"), "utf8"),
    );
    expect(general.source).toMatchObject({
      consolidation_run_id: "cr_briefing",
      persona_applied: true,
      raw_text_included: false,
    });
    expect(general.title_variants).toMatchObject({
      morning: "What should we open this morning?",
      afternoon: "What should we open this afternoon?",
      evening: "What should we open this evening?",
      night: "What should we open tonight?",
    });
    expect(project).toMatchObject({
      scope: "project",
      project_id: "butler",
      project_name: "Butler",
      raw_text_included: false,
    });
    expect(project.title_variants).toBeUndefined();
    expect(readFileSync(result.summary_path, "utf8")).toContain("\"usage\"");
    expect(readFileSync(result.summary_path, "utf8")).not.toContain("Use concise, calm product copy.");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("consolidation usage falls back to prompt-cache metrics when runners return text only", async () => {
  const butlerData = tempData();
  try {
    const result = await runCognitionConsolidationCycle({
      butlerData,
      runId: "cr_prompt_cache_usage",
      now: new Date("2026-05-28T19:06:50.238Z"),
      newChatBriefingModelRunner: async (input) => {
        appendPromptCacheMetric({
          ts: Date.now(),
          model: "gpt-5.5",
          scope: input.cacheScope,
          promptTokens: 1_000,
          cachedTokens: 250,
          totalTokens: 1_400,
        }, { butlerData });
        return JSON.stringify({
          moment: "7:06 PM",
          title: "What should we open today?",
          description: "A few starting points are ready.",
          suggestions: [
            {
              id: "one",
              title: "One",
              description: "Useful to open.",
              text: "Open one.",
              source_kind: "current_interest",
            },
            {
              id: "two",
              title: "Two",
              description: "Useful to compare.",
              text: "Open two.",
              source_kind: "adjacent_direction",
            },
            {
              id: "three",
              title: "Three",
              description: "Useful to narrow.",
              text: "Open three.",
              source_kind: "unfinished_topic",
            },
            {
              id: "four",
              title: "Four",
              description: "Useful to begin.",
              text: "Open four.",
              source_kind: "timely_context",
            },
          ],
        });
      },
    });

    const briefingUsage = result.usage.phases.find((phase) => phase.phase === "new_chat_briefing");
    expect(briefingUsage).toMatchObject({
      request_count: 1,
      prompt_tokens: 1_000,
      cached_input_tokens: 250,
      uncached_input_tokens: 750,
      output_tokens: 400,
      total_tokens: 1_400,
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("consolidation cycle pauses on mid-run rate limit and resumes from checkpoint", async () => {
  const butlerData = tempData();
  try {
    let calls = 0;
    const paused = await runCognitionConsolidationCycle({
      butlerData,
      runId: "cr_resume",
      rateLimitBudget: () => {
        calls += 1;
        return calls >= 4
          ? { remainingRatio: 0.02, resetAt: "2026-05-15T01:00:00.000Z" }
          : { remainingRatio: 0.9 };
      },
    });
    expect(paused.status).toBe("paused_rate_limited");
    expect(readConsolidationCheckpoint(butlerData, "cr_resume")?.status).toBe("paused_rate_limited");

    const resumed = await runCognitionConsolidationCycle({
      butlerData,
      runId: "cr_resume",
      resume: true,
      rateLimitBudget: () => ({ remainingRatio: 0.9 }),
    });
    expect(resumed.status).toBe("completed");
    expect(readConsolidationCheckpoint(butlerData, "cr_resume")?.next_phase_index).toBe(11);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

function transcriptEvent(eventId: string, timestamp: string, text: string): string {
  return JSON.stringify({
    eventId,
    sessionId: "butler_app-general",
    kind: "inbound",
    timestamp,
    payload: { message: { text } },
  });
}

test("consolidation cycle prunes only expired unpinned box-owned content", async () => {
  const butlerData = tempData();
  try {
    const expired = createBoxItem(butlerData, {
      kind: "tool_result",
      title: "Expired",
      summary: "Expired content",
      origin: { producer: "unit-test" },
      content: [{ filename: "expired.txt", data: "delete me", mimeType: "text/plain" }],
      retention: { class: "working", pinned: false, expires_at: "2026-05-14T00:00:00.000Z" },
    });
    const pinned = createBoxItem(butlerData, {
      kind: "tool_result",
      title: "Pinned",
      summary: "Pinned content",
      origin: { producer: "unit-test" },
      content: [{ filename: "pinned.txt", data: "keep me", mimeType: "text/plain" }],
      retention: { class: "working", pinned: true, expires_at: "2026-05-14T00:00:00.000Z" },
    });

    const result = await runCognitionConsolidationCycle({ butlerData, runId: "cr_retention" });
    const retention = result.phases.find((phase) => phase.phase === "box_retention")?.metrics;
    expect(retention).toMatchObject({ expired_candidate_count: 1, pruned_box_owned_count: 1 });
    expect(readBoxManifest(butlerData, expired.box_item_id)?.status).toBe("forgotten");
    expect(readBoxManifest(butlerData, pinned.box_item_id)?.status).toBe("pending");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("consolidation cycle reports held lock without mutating state", async () => {
  const butlerData = tempData();
  try {
    const lockPath = consolidationLockPath(butlerData);
    const { mkdirSync, writeFileSync } = await import("fs");
    mkdirSync(join(lockPath, ".."), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), host: "test" }), "utf8");
    const result = await runCognitionConsolidationCycle({ butlerData, runId: "cr_locked" });
    expect(result.status).toBe("lock_held");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("live runtime turns continue while consolidation lock is held", async () => {
  const butlerData = tempData();
  const originalButlerData = process.env.BUTLER_DATA;
  try {
    process.env.BUTLER_DATA = butlerData;
    addFeedbackEntry(butlerData, {
      text: "통합 주기 중에도 이 최신 피드백을 우선 적용하세요.",
      targetRef: "persona:runtime",
      category: "style",
      promotionTarget: "persona",
    });

    let releasePhase!: () => void;
    const phaseRelease = new Promise<void>((resolve) => {
      releasePhase = resolve;
    });
    let enteredPhase!: () => void;
    const phaseEntered = new Promise<void>((resolve) => {
      enteredPhase = resolve;
    });

    const cycle = runCognitionConsolidationCycle({
      butlerData,
      runId: "cr_live",
      phaseHook: async (phase) => {
        if (phase !== "box_index") return;
        enteredPhase();
        await phaseRelease;
      },
    });
    await phaseEntered;

    let capturedPrompt = "";
    const runtime = new NativeToolLoopRuntime({
      runFunctionToolPromptText: async (input) => {
        capturedPrompt = input.prompt;
        return "계속 사용 가능합니다.";
      },
    });
    const handle = await runtime.createSession({
      sessionId: "butler/live-during-consolidation",
      role: "butler",
      workspacePath: butlerData,
      systemPrompt: "You are Butler.",
    });
    const turn = await runtime.runTurn({
      handle,
      provider: fakeProvider,
      model: "openai/auto:codex-latest",
      input: {
        eventId: "mock:live-consolidation",
        accountId: "default",
        transport: "mock",
        peer: { kind: "dm", id: "peer" },
        sender: { id: "user" },
        message: {
          id: "msg-live",
          text: "지금도 응답해줘",
          timestamp: new Date().toISOString(),
        },
      },
    });

    releasePhase();
    const result = await cycle;
    expect(turn.text).toBe("계속 사용 가능합니다.");
    expect(capturedPrompt).toContain("통합 주기 중에도 이 최신 피드백을 우선 적용하세요.");
    expect(result.status).toBe("completed");
  } finally {
    if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
    else process.env.BUTLER_DATA = originalButlerData;
    rmSync(butlerData, { recursive: true, force: true });
  }
});
