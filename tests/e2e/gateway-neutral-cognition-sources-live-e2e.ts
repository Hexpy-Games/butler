import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { queryMemory, indexTranscriptLinesForQuery } from "../../packages/butler-agent/src/agent/cognition/memory/exact-query.ts";
import {
  captureProfileCandidatesFromTranscriptsWithModel,
  listProfileCandidates,
  writeProfilingConsentSnapshot,
  type ProfileExtractorModelRunnerInput,
} from "../../packages/butler-agent/src/personalization/profiling.ts";
import { runPromptTextWithUsage } from "../../packages/butler-agent/src/integrations/providers/provider.ts";
import { loadPrivateEnvIntoProcess } from "../../packages/butler-agent/src/interfaces/cli/private-env.ts";

const previousButlerData = process.env.BUTLER_DATA;
const previousRuntime = process.env.BUTLER_RUNTIME;
const sourceButlerData = process.env.BUTLER_LIVE_SOURCE_BUTLER_DATA ||
  previousButlerData ||
  join(process.env.HOME ?? "", ".butler");
const tempDir = mkdtempSync(join(tmpdir(), "butler-gncc-cognition-live-e2e-"));
const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const model = normalizeE2eModel(process.env.BUTLER_GNCC_COGNITION_E2E_MODEL || "openai/gpt-5.5");
const reasoningEffort = process.env.BUTLER_GNCC_COGNITION_E2E_REASONING || "low";
const canonicalMarker = `LIVE_GNCC_COGNITION_CANONICAL_${runId}`;
const transcriptDecoy = `LIVE_GNCC_COGNITION_TRANSCRIPT_DECOY_${runId}`;

const prompts: string[] = [];
const reasoning: string[] = [];
let liveModelCalls = 0;

try {
  loadPrivateEnvIntoProcess(sourceButlerData);
  process.env.BUTLER_DATA = tempDir;
  process.env.BUTLER_RUNTIME ||= "codex-api";

  assert(model === "openai/gpt-5.5", `GNCC cognition live E2E must use GPT-5.5, got ${model}`);
  assert(reasoningEffort === "low" || reasoningEffort === "medium", `GNCC cognition live E2E reasoning must be low or medium, got ${reasoningEffort}`);

  writeFileSync(join(tempDir, "butler.config.json"), JSON.stringify({
    system: { defaultModel: model },
    personalization: {
      profiling: {
        extractorModel: model,
        extractorReasoningEffort: reasoningEffort,
      },
    },
  }, null, 2), "utf8");

  seedCanonicalConversation();
  indexTranscriptLinesForQuery({
    butlerData: tempDir,
    transcriptFile: "audit-decoy.jsonl",
    lines: [
      JSON.stringify({
        eventId: "evt_transcript_decoy",
        sessionId: "butler/main",
        kind: "inbound",
        timestamp: "2026-07-02T00:00:03.000Z",
        payload: { message: { text: `${transcriptDecoy} ${canonicalMarker}` } },
      }),
    ],
  });

  const exact = queryMemory({
    butlerData: tempDir,
    query: canonicalMarker,
    speaker: "user",
    order: "earliest",
    limit: 5,
  });

  assert(exact.inspected_sources[0] === "conversation-store", `query_memory did not inspect conversation store first: ${JSON.stringify(exact.inspected_sources)}`);
  assert(exact.skipped_sources.includes("transcript-recovery-index: transcript recovery source not requested"), `transcript recovery was not explicitly skipped: ${JSON.stringify(exact.skipped_sources)}`);
  assert(exact.results.some((item) => item.source === "conversation-store" && item.conversation_message_id === "cm_query_user"), `canonical query result missing: ${JSON.stringify(exact.results)}`);
  assert(!JSON.stringify(exact.results).includes(transcriptDecoy), "default exact query leaked transcript recovery decoy");

  writeProfilingConsentSnapshot(tempDir, {
    mode: "deep",
    consented_at: "2026-07-02T00:00:00.000Z",
  });
  const capture = await captureProfileCandidatesFromTranscriptsWithModel(tempDir, {
    model,
    maxUserMessages: 10,
    modelRunner: liveProfileRunner,
  });
  const candidates = listProfileCandidates(tempDir);

  assert(liveModelCalls >= 1, "profile extraction did not call the live model");
  assert(reasoning.every((value) => value === reasoningEffort), `unexpected reasoning efforts: ${reasoning.join(",")}`);
  assert(prompts[0]?.includes("ref=conversation:cm_profile_user"), "profile prompt did not cite canonical conversation evidence");
  assert(!prompts[0]?.includes("ref=transcript:"), "profile prompt included transcript evidence refs");
  assert(capture.semantic_scanned_message_count >= 2, `semantic scan count missing: ${JSON.stringify(capture)}`);
  assert(capture.audit_transcript_scanned_event_count === 0, `audit transcript count should stay separate and zero by default: ${JSON.stringify(capture)}`);
  assert(candidates.every((candidate) => candidate.evidence_refs.every((ref) => ref.startsWith("conversation:"))), `profile candidates did not preserve canonical refs: ${JSON.stringify(candidates)}`);

  console.log(JSON.stringify({
    ok: true,
    service: "gateway-neutral-cognition-sources-live-e2e",
    model,
    reasoningEffort,
    liveModelCalls,
    canonicalMarker,
    querySources: exact.inspected_sources,
    transcriptRecoverySkipped: exact.skipped_sources.includes("transcript-recovery-index: transcript recovery source not requested"),
    profilePromptUsedCanonicalRefs: prompts[0]?.includes("ref=conversation:cm_profile_user") === true,
    profileCandidateCount: candidates.length,
    semanticScannedMessageCount: capture.semantic_scanned_message_count,
    auditTranscriptScannedEventCount: capture.audit_transcript_scanned_event_count,
  }, null, 2));
} finally {
  if (previousButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = previousButlerData;
  if (previousRuntime === undefined) delete process.env.BUTLER_RUNTIME;
  else process.env.BUTLER_RUNTIME = previousRuntime;
  rmSync(tempDir, { recursive: true, force: true });
}

function seedCanonicalConversation(): void {
  let next = 0;
  const store = new AgentConversationStore({
    butlerData: tempDir,
    idFactory: (prefix) => `${prefix}_gncc_cognition_${++next}`,
  });
  try {
    const turn = store.beginTurn({
      gateway: "app",
      externalSessionId: "general",
      sessionId: "cs_gncc_cognition",
      actor: "user",
      now: "2026-07-02T00:00:00.000Z",
    });
    store.appendUserMessage({
      sessionId: "cs_gncc_cognition",
      turnId: turn.id,
      messageId: "cm_query_user",
      text: `Canonical exact query evidence ${canonicalMarker}`,
      sourceGateway: "app",
      sourceRef: "evt_query_user",
      now: "2026-07-02T00:00:01.000Z",
    });
    store.appendUserMessage({
      sessionId: "cs_gncc_cognition",
      turnId: turn.id,
      messageId: "cm_profile_user",
      text: "앞으로 답변은 짧고 근거 중심으로 해줘. 이건 내 명시적인 커뮤니케이션 선호야.",
      sourceGateway: "app",
      sourceRef: "evt_profile_user",
      now: "2026-07-02T00:00:02.000Z",
    });
  } finally {
    store.close();
  }
}

async function liveProfileRunner(input: ProfileExtractorModelRunnerInput) {
  liveModelCalls += 1;
  prompts.push(input.prompt);
  reasoning.push(input.reasoningEffort);
  return await runPromptTextWithUsage({
    prompt: input.prompt,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    instructions: input.instructions,
    cacheScope: input.cacheScope,
    butlerData: input.butlerData,
    signal: input.signal,
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function normalizeE2eModel(value: string): `${string}/${string}` {
  const trimmed = value.trim();
  if (trimmed === "gpt-5.5") return "openai/gpt-5.5";
  if (trimmed.includes("/")) return trimmed as `${string}/${string}`;
  throw new Error(`GNCC cognition live E2E model must be provider/model, got ${value}`);
}
