import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { recordOperationalMetric } from "../../../operations/metrics/operational-metrics.ts";
import {
  captureProfileCandidatesFromFeedback,
  captureProfileCandidatesFromTranscriptsWithModel,
  consolidateProfileCandidates,
  isProfilingEnabled,
} from "../../../personalization/profiling.ts";
import { boxItemRoot, listBoxManifests, rebuildBoxIndex, writeBoxManifest, type BoxManifest } from "../box/store.ts";
import { activeFeedbackEntries, resolveFeedbackEntry } from "../feedback/buffer.ts";
import { aggregateSourceQuality, listKnowHowEntries, rebuildKnowHowIndex, writeKnowHowEntry, type KnowHowEntry } from "../know-how/store.ts";
import { checkMemoryMetadataIntegrity } from "../memory/metadata.ts";
import { readMemoryHealth } from "../memory/quality.ts";
import { runBtccRetrospective } from "../retrospective/index.ts";
import type {
  ConsolidationPhase,
  RunCognitionConsolidationInput,
} from "./cycle.ts";
import { generateNewChatBriefings } from "./new-chat-briefing.ts";

export async function runConsolidationPhase(
  butlerData: string,
  phase: ConsolidationPhase,
  input: RunCognitionConsolidationInput,
): Promise<Record<string, unknown>> {
  if (phase === "preflight") return { ok: true };
  if (phase === "feedback_triage") {
    return { active_feedback_count: activeFeedbackEntries(butlerData).length };
  }
  if (phase === "btcc_retrospective") {
    return await runBtccRetrospective({
      butlerData,
      dbPath: input.btccDbPath ?? join(butlerData, "app-server", "butler-client.sqlite"),
      runId: input.runId,
      ...(input.btccRetrospectiveModelRunner
        ? { modelRunner: input.btccRetrospectiveModelRunner }
        : {}),
    });
  }
  if (phase === "profile_consolidation") return await consolidateProfile(butlerData, input);
  if (phase === "new_chat_briefing") {
    return await generateNewChatBriefings({
      butlerData,
      runId: input.runId ?? "cr_unknown",
      now: input.now,
      modelRunner: input.newChatBriefingModelRunner,
    });
  }
  if (phase === "box_index") {
    const report = rebuildBoxIndex(butlerData);
    return { indexed_count: report.indexed_count, skipped_count: report.skipped_count };
  }
  if (phase === "memory_metadata_integrity") {
    const report = checkMemoryMetadataIntegrity(butlerData);
    return {
      chunk_count: report.chunk_count,
      missing_box_refs_count: report.missing_box_refs.length,
      missing_feedback_refs_count: report.missing_feedback_refs.length,
    };
  }
  if (phase === "source_quality_aggregation") {
    const summaries = aggregateSourceQuality(butlerData);
    const index = rebuildKnowHowIndex(butlerData);
    return { source_quality_summary_count: summaries.length, knowhow_indexed_count: index.indexed_count };
  }
  if (phase === "knowhow_revision") return reviseKnowHow(butlerData);
  if (phase === "memory_health") {
    const health = readMemoryHealth({ butlerData });
    return {
      memory_chunks_count: health.memoryChunkCount,
      vector_rows_count: health.vectorRowCount,
      maintenance_status: health.maintenanceStatus,
      diagnostics_count: health.diagnostics.length,
    };
  }
  if (phase === "box_retention") return pruneExpiredBoxContent(butlerData);
  recordOperationalMetric({
    category: "memory",
    name: "consolidation_cycle",
    status: "ok",
    dimensions: { raw_text_included: false },
  }, { butlerData });
  return { raw_text_included: false };
}

async function consolidateProfile(
  butlerData: string,
  input: RunCognitionConsolidationInput,
): Promise<Record<string, unknown>> {
  const feedback = activeFeedbackEntries(butlerData)
    .filter((entry) => entry.promotion_target === "profile_candidate");
  if (!isProfilingEnabled(butlerData)) {
    return {
      profiling_enabled: false,
      profile_feedback_count: feedback.length,
      captured_candidate_count: 0,
      applied_feedback_count: 0,
      raw_text_included: false,
    };
  }

  const transcriptSince = input.profileTranscriptSince ?? latestProfileRun(butlerData, input.runId);
  const capture = await captureProfileCandidatesFromTranscriptsWithModel(butlerData, {
    modelRunner: input.profileExtractorModelRunner,
    since: transcriptSince,
    cacheScope: `cognition:${input.runId ?? "cr_unknown"}:profile_consolidation:profile-extractor`,
  });
  let capturedCandidates = 0;
  let appliedFeedback = 0;
  for (const entry of feedback) {
    const records = captureProfileCandidatesFromFeedback(butlerData, {
      feedback_id: entry.feedback_id,
      category: entry.category,
      promotion_target: entry.promotion_target,
      target_ref: entry.target_ref,
      text: entry.text,
      created_at: entry.created_at,
      privacy_class: entry.privacy_class,
    });
    if (records.length === 0) continue;
    capturedCandidates += records.length;
    resolveFeedbackEntry(butlerData, entry.feedback_id, "applied");
    appliedFeedback += 1;
  }
  return {
    ...consolidateProfileCandidates(butlerData),
    profile_feedback_count: feedback.length,
    transcript_since: normalizeSince(transcriptSince),
    semantic_scanned_session_count: capture.semantic_scanned_session_count,
    semantic_scanned_message_count: capture.semantic_scanned_message_count,
    semantic_captured_candidate_count: capture.captured_candidate_count,
    audit_transcript_scanned_file_count: capture.audit_transcript_scanned_file_count,
    audit_transcript_scanned_event_count: capture.audit_transcript_scanned_event_count,
    transcript_scanned_file_count: capture.audit_transcript_scanned_file_count,
    transcript_scanned_event_count: capture.audit_transcript_scanned_event_count,
    transcript_captured_candidate_count: capture.captured_candidate_count,
    transcript_extractor_model: capture.extractor_model.effective_model,
    transcript_extractor_uses_butler_model: capture.extractor_model.uses_butler_model,
    transcript_extractor_model_called: capture.model_called,
    transcript_extractor_fallback_used: capture.fallback_used,
    transcript_extractor_error: capture.model_error ? "profile extractor model failed" : undefined,
    model_usage: capture.model_usage,
    captured_candidate_count: capturedCandidates,
    applied_feedback_count: appliedFeedback,
    raw_text_included: false,
  };
}

function reviseKnowHow(butlerData: string): Record<string, unknown> {
  const feedback = activeFeedbackEntries(butlerData);
  const qualityBySource = new Map(
    aggregateSourceQuality(butlerData).map((item) => [item.source_id, item]),
  );
  let revised = 0;
  let demoted = 0;
  let appliedFeedback = 0;
  for (const entry of listKnowHowEntries(butlerData)) {
    let next: KnowHowEntry = entry;
    const targeted = feedback.filter((item) =>
      item.target_ref === `knowhow:${entry.knowhow_id}` ||
      entry.strategy.preferred_sources.some((source) => item.target_ref === `source:${source}`)
    );
    if (targeted.length > 0) {
      next = reviseFromFeedback(entry, targeted);
      for (const item of targeted) {
        resolveFeedbackEntry(butlerData, item.feedback_id, "applied");
        appliedFeedback += 1;
      }
    }
    const scores = next.strategy.preferred_sources
      .map((source) => qualityBySource.get(source)?.score)
      .filter((score): score is number => typeof score === "number");
    if (scores.some((score) => score < 0.35)) {
      next = { ...next, status: "disabled", updated_at: iso() };
      demoted += 1;
    } else if (scores.some((score) => score < 0.55) && next.status === "active") {
      next = { ...next, status: "needs_review", updated_at: iso() };
      demoted += 1;
    }
    if (next !== entry) {
      writeKnowHowEntry(butlerData, next);
      revised += 1;
    }
  }
  return { revised_knowhow_count: revised, demoted_knowhow_count: demoted, applied_feedback_count: appliedFeedback };
}

function reviseFromFeedback(entry: KnowHowEntry, targeted: ReturnType<typeof activeFeedbackEntries>) {
  const disable = targeted.some((item) => item.category === "source_policy");
  return {
    ...entry,
    status: disable ? "disabled" as const : "needs_review" as const,
    updated_at: iso(),
    quality: {
      ...entry.quality,
      score: Math.max(0, Number((entry.quality.score - 0.25).toFixed(3))),
      negative_feedback_count: entry.quality.negative_feedback_count + targeted.length,
    },
    refs: {
      ...entry.refs,
      feedback_ids: [...new Set([...entry.refs.feedback_ids, ...targeted.map((item) => item.feedback_id)])],
    },
    revision_history: [
      ...entry.revision_history,
      { at: iso(), kind: "feedback_revision", feedback_ids: targeted.map((item) => item.feedback_id), previous_status: entry.status },
    ],
  };
}

function pruneExpiredBoxContent(butlerData: string): Record<string, unknown> {
  let pruned = 0;
  let candidates = 0;
  for (const manifest of listBoxManifests(butlerData)) {
    if (manifest.retention.pinned || !manifest.retention.expires_at) continue;
    const expires = Date.parse(manifest.retention.expires_at);
    if (!Number.isFinite(expires) || expires > Date.now()) continue;
    candidates += 1;
    if (!manifest.files.every((file) => file.ownership === "box-owned")) continue;
    for (const file of manifest.files) {
      if (file.box_relative_path) {
        rmSync(join(boxItemRoot(butlerData, manifest.box_item_id), file.box_relative_path), { force: true });
      }
    }
    writeBoxManifest(butlerData, forgottenManifest(manifest));
    pruned += 1;
  }
  return { expired_candidate_count: candidates, pruned_box_owned_count: pruned };
}

function forgottenManifest(manifest: BoxManifest): BoxManifest {
  return {
    ...manifest,
    status: "forgotten",
    updated_at: iso(),
    quality: { ...manifest.quality, signals: [...manifest.quality.signals, "retention_pruned"] },
  };
}

function latestProfileRun(butlerData: string, currentRunId?: string): string | null {
  const root = join(butlerData, "cognition", "consolidation", "runs");
  if (!existsSync(root)) return null;
  let latest: { completedAt: string; ms: number } | null = null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const summary = readJson(join(root, entry.name));
    if (!summary || summary.run_id === currentRunId ||
      (summary.status !== "completed" && summary.status !== "completed_with_errors")) continue;
    const completedAt = typeof summary.completed_at === "string" ? summary.completed_at : null;
    const phases = Array.isArray(summary.phases) ? summary.phases : [];
    if (!completedAt || !phases.some((phase) =>
      phase && typeof phase === "object" &&
      (phase as { phase?: unknown }).phase === "profile_consolidation" &&
      (phase as { status?: unknown }).status === "ok")) continue;
    const ms = Date.parse(completedAt);
    if (Number.isFinite(ms) && (!latest || ms > latest.ms)) latest = { completedAt, ms };
  }
  return latest?.completedAt ?? null;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function normalizeSince(value: string | Date | null | undefined): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

function iso(): string {
  return new Date().toISOString();
}
