import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoxItem, readBoxManifest, rebuildBoxIndex } from "../../packages/butler-agent/src/agent/cognition/box/store.ts";
import { captureUserFeedbackFromMessage } from "../../packages/butler-agent/src/agent/cognition/feedback/capture.ts";
import { addFeedbackEntry, readFeedbackEntry } from "../../packages/butler-agent/src/agent/cognition/feedback/buffer.ts";
import {
  aggregateSourceQuality,
  createKnowHowEntry,
  readKnowHowEntry,
  recordSourceQualityEvent,
  retrieveKnowHow,
} from "../../packages/butler-agent/src/agent/cognition/know-how/store.ts";
import { runCognitionConsolidationCycle } from "../../packages/butler-agent/src/agent/cognition/consolidation/cycle.ts";
import {
  checkMemoryMetadataIntegrity,
  createMemoryChunk,
  readMemoryChunkWithRefs,
} from "../../packages/butler-agent/src/agent/cognition/memory/metadata.ts";

test("non-weather operational learning demotes a docs-source know-how from real feedback and evidence links", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-cognition-scenario-"));
  try {
    const box = createBoxItem(butlerData, {
      kind: "source_snapshot",
      status: "indexed",
      title: "Docs search source evidence",
      summary: "Documentation source produced an API lookup result.",
      tags: ["docs", "api"],
      origin: {
        producer: "docs-search",
        session_id: "butler/app-general",
        turn_id: "turn-docs-1",
        message_id: "message-docs-1",
        tool_call_id: "tool-docs-1",
      },
      source: {
        uri: "https://docs.example.com/api/search",
        provider: "docs-search",
        fetched_at: "2026-05-15T00:00:00.000Z",
        observed_at: "2026-05-15T00:00:00.000Z",
      },
      content: [{ filename: "result.txt", data: "API lookup evidence body", mimeType: "text/plain" }],
      retention: { class: "pinned", pinned: true },
    });
    const chunk = createMemoryChunk(butlerData, {
      scope: "project",
      projectId: "butler",
      summary: "Docs source evidence supports API lookup know-how.",
      source: "docs-search",
      origins: [{ ref_type: "turn", ref_id: "turn-docs-1" }],
      boxRefs: [{ box_item_id: box.box_item_id, relation: "evidence" }],
      graphRefs: [{ graph_ref_type: "source", graph_ref_id: "docs.example.com", relation: "supports" }],
      vectorRefs: [{
        vector_store: "butler-local",
        vector_table: "memory_chunks",
        vector_row_id: "vec_docs_1",
        embedding_model: "test-embedding",
        embedding_dimension: 8,
      }],
    });
    const knowHow = createKnowHowEntry(butlerData, {
      name: "api_docs_lookup",
      aliases: ["docs lookup", "api reference"],
      status: "active",
      summary: "Use the project documentation source for API reference lookups.",
      intent_match: {
        topics: ["api", "documentation", "reference"],
        examples: ["find API docs", "lookup endpoint reference"],
      },
      strategy: {
        steps: ["query docs source", "validate source timestamp", "cite the current docs result"],
        preferred_sources: ["docs.example.com"],
      },
      refs: {
        box_item_ids: [box.box_item_id],
        memory_chunk_ids: [chunk.memory_chunk_id],
        feedback_ids: [],
        consolidation_run_ids: [],
      },
      quality: {
        score: 0.84,
        confidence: 0.78,
        success_count: 3,
        failure_count: 0,
        negative_feedback_count: 0,
        last_used_at: null,
        last_validated_at: null,
      },
    });
    recordSourceQualityEvent(butlerData, {
      source_id: "docs.example.com",
      source_uri: "https://docs.example.com",
      tool_name: "docs-search",
      observed_at: "2026-05-15T00:00:00.000Z",
      task_kind: "api_docs_lookup",
      freshness_score: 0.9,
      success: true,
      latency_ms: 80,
      user_feedback: "positive",
      box_item_id: box.box_item_id,
      feedback_id: null,
      consolidation_run_id: null,
    });

    expect(rebuildBoxIndex(butlerData).indexed_count).toBe(1);
    expect(retrieveKnowHow({ butlerData, query: "find API docs for endpoint" }).selected?.knowhow_id)
      .toBe(knowHow.knowhow_id);
    expect(checkMemoryMetadataIntegrity(butlerData).missing_box_refs).toEqual([]);
    expect(readMemoryChunkWithRefs(butlerData, chunk.memory_chunk_id)?.vector_refs[0]?.vector_row_id)
      .toBe("vec_docs_1");

    const captured = captureUserFeedbackFromMessage({
      butlerData,
      text: "이제 source docs.example.com 쓰지마. 문서 검색 결과가 별로였어.",
      chatId: "general",
      turnId: "turn-docs-feedback",
      messageId: "message-docs-feedback",
    });
    expect(captured).toBeNull();
    const explicitFeedback = addFeedbackEntry(butlerData, {
      text: "Do not use docs.example.com for API lookup results.",
      priority: "high",
      targetRef: "source:docs.example.com",
      category: "source_policy",
      scope: "source",
      promotionTarget: "source_quality",
    });
    expect(explicitFeedback).toMatchObject({
      category: "source_policy",
      scope: "source",
      target_ref: "source:docs.example.com",
      promotion_target: "source_quality",
    });
    expect(retrieveKnowHow({ butlerData, query: "lookup endpoint reference" }).selected).toBeNull();

    const run = await runCognitionConsolidationCycle({
      butlerData,
      manual: true,
      runId: "cr_docs_learning",
    });
    expect(run.status).toBe("completed");
    const revised = readKnowHowEntry(butlerData, knowHow.knowhow_id);
    expect(revised?.status).toBe("disabled");
    expect(revised?.quality.negative_feedback_count).toBe(1);
    expect(revised?.refs.feedback_ids).toEqual([explicitFeedback.feedback_id]);
    expect(readFeedbackEntry(butlerData, explicitFeedback.feedback_id)?.status).toBe("applied");
    expect(readBoxManifest(butlerData, box.box_item_id)?.status).toBe("indexed");
    expect(aggregateSourceQuality(butlerData)[0]).toMatchObject({
      source_id: "docs.example.com",
      tool_name: "docs-search",
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
