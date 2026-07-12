import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHistoricalRecoveryReport,
  classifyHistoricalRows,
  runHistoricalConversationRecovery,
} from "../../packages/butler-agent/src/agent/conversation/historical-recovery.ts";
import { readConversationObservations } from "../../packages/butler-agent/src/agent/cognition/memory/scripts/lib/conversation-sources.ts";
import { runPromptTextWithUsage } from "../../packages/butler-agent/src/integrations/providers/provider.ts";
import { loadPrivateEnvIntoProcess } from "../../packages/butler-agent/src/interfaces/cli/private-env.ts";

const previousButlerData = process.env.BUTLER_DATA;
const previousRuntime = process.env.BUTLER_RUNTIME;
const sourceButlerData = process.env.BUTLER_LIVE_SOURCE_BUTLER_DATA ||
  previousButlerData ||
  join(process.env.HOME ?? "", ".butler");
const tempDir = mkdtempSync(join(tmpdir(), "butler-gncc-recovery-live-e2e-"));
const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const model = normalizeE2eModel(process.env.BUTLER_GNCC_RECOVERY_E2E_MODEL || "openai/gpt-5.6-sol");
const reasoningEffort = process.env.BUTLER_GNCC_RECOVERY_E2E_REASONING || "low";
const secretTranscriptText = `LIVE_GNCC_RECOVERY_SECRET_${runId}`;

try {
  loadPrivateEnvIntoProcess(sourceButlerData);
  process.env.BUTLER_DATA = tempDir;
  process.env.BUTLER_RUNTIME ||= "codex-api";

  assert(model === "openai/gpt-5.6-sol", `GNCC recovery live E2E must use GPT-5.6 Sol, got ${model}`);
  assert(reasoningEffort === "low" || reasoningEffort === "medium", `GNCC recovery live E2E reasoning must be low or medium, got ${reasoningEffort}`);

  writeFileSync(join(tempDir, "butler.config.json"), JSON.stringify({
    system: { defaultModel: model },
  }, null, 2), "utf8");

  const transcriptRows = [
    transcriptRow("evt-live-recovered", "inbound", secretTranscriptText),
    transcriptRow("evt-live-delivery", "delivery", "delivery payload should be discarded"),
    {
      eventId: "evt-live-ambiguous",
      sessionId: "legacy/live",
      kind: "turn",
      timestamp: "2026-07-02T00:00:03.000Z",
      payload: { text: `AMBIGUOUS_${secretTranscriptText}` },
    },
  ];
  const appRows = [{
    id: "app-live-trusted",
    chat_id: "general",
    role: "assistant",
    text: "trusted app projection answer",
    created_at: "2026-07-02T00:00:04.000Z",
    conversation_session_id: "cs_live_trusted",
    conversation_message_id: "cm_live_trusted",
  }];
  const decisions = classifyHistoricalRows({ transcriptRows, appRows });
  const dryRun = buildHistoricalRecoveryReport({ decisions, dryRun: true });
  const prompt = [
    "You are auditing a Butler historical conversation recovery dry-run report.",
    "Pass only if the report is redacted, contains counts for trusted/recovered/discarded/ambiguous rows, and does not contain raw conversation text.",
    "Return exactly RECOVERY_REPORT_SAFE_PASS or RECOVERY_REPORT_SAFE_FAIL.",
    "",
    JSON.stringify(dryRun, null, 2),
  ].join("\n");
  assert(!prompt.includes(secretTranscriptText), "live model prompt leaked raw transcript text");

  const review = await runPromptTextWithUsage({
    butlerData: tempDir,
    model,
    reasoningEffort,
    prompt,
    instructions: "You are a strict recovery report safety auditor.",
    cacheScope: "gncc-historical-recovery-live-e2e",
  });
  assert(review.text.includes("RECOVERY_REPORT_SAFE_PASS"), `live model did not pass redacted report: ${review.text}`);

  const imported = runHistoricalConversationRecovery({
    butlerData: tempDir,
    dryRun: false,
    transcriptRows,
    appRows,
  });
  const observations = readConversationObservations({
    butlerData: tempDir,
    includeCompacted: true,
  });

  assert(imported.counts.imported === 2, `expected two imported semantic rows: ${JSON.stringify(imported.counts)}`);
  assert(imported.counts.ambiguous === 1, `ambiguous count missing: ${JSON.stringify(imported.counts)}`);
  assert(observations.some((observation) => observation.provenance === "recovered"), "recovered row missing from canonical observations");
  assert(observations.some((observation) => observation.provenance === "trusted"), "trusted row missing from canonical observations");
  assert(!JSON.stringify(observations).includes(`AMBIGUOUS_${secretTranscriptText}`), "ambiguous row entered canonical observations");

  console.log(JSON.stringify({
    ok: true,
    service: "gateway-neutral-historical-recovery-live-e2e",
    model,
    reasoningEffort,
    liveModelCalls: 1,
    dryRunCounts: dryRun.counts,
    importedCounts: imported.counts,
    promptRedacted: !prompt.includes(secretTranscriptText),
    ambiguousExcluded: !JSON.stringify(observations).includes(`AMBIGUOUS_${secretTranscriptText}`),
  }, null, 2));
} finally {
  if (previousButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = previousButlerData;
  if (previousRuntime === undefined) delete process.env.BUTLER_RUNTIME;
  else process.env.BUTLER_RUNTIME = previousRuntime;
  rmSync(tempDir, { recursive: true, force: true });
}

function transcriptRow(eventId: string, kind: string, text: string) {
  return {
    eventId,
    sessionId: "legacy/live",
    kind,
    timestamp: "2026-07-02T00:00:01.000Z",
    payload: {
      eventId,
      message: {
        text,
        timestamp: "2026-07-02T00:00:01.000Z",
      },
    },
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function normalizeE2eModel(value: string): `${string}/${string}` {
  const trimmed = value.trim();
  if (trimmed === "gpt-5.6-sol") return "openai/gpt-5.6-sol";
  if (trimmed.includes("/")) return trimmed as `${string}/${string}`;
  throw new Error(`GNCC recovery live E2E model must be provider/model, got ${value}`);
}
