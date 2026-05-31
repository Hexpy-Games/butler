import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createBoxItem } from "../../packages/butler-agent/src/agent/cognition/box/store.ts";
import { addFeedbackEntry } from "../../packages/butler-agent/src/agent/cognition/feedback/buffer.ts";
import {
  checkMemoryMetadataIntegrity,
  createMemoryChunk,
  linkMemoryChunkBox,
  linkMemoryChunkFeedback,
  linkMemoryChunkGraph,
  linkMemoryChunkOrigin,
  linkMemoryChunkVector,
  listMemoryChunks,
  memoryMetadataPath,
  readMemoryChunkWithRefs,
} from "../../packages/butler-agent/src/agent/cognition/memory/metadata.ts";

function tempData(): string {
  return mkdtempSync(join(tmpdir(), "butler-memory-metadata-"));
}

test("memory metadata stores memory_chunk_id centered origin Box feedback graph and vector refs", () => {
  const butlerData = tempData();
  try {
    const box = createBoxItem(butlerData, {
      kind: "source_snapshot",
      title: "Weather source evidence",
      summary: "Weather evidence summary.",
      origin: { producer: "unit-test", session_id: "butler/main" },
      content: [{ filename: "source.json", data: "{}", mimeType: "application/json" }],
    });
    const feedback = addFeedbackEntry(butlerData, {
      text: "이 소스는 정확도가 낮았습니다.",
      targetRef: `box:${box.box_item_id}`,
      category: "source_quality",
    });

    const chunk = createMemoryChunk(butlerData, {
      scope: "global",
      projectId: "butler",
      summary: "Weather source had negative user feedback.",
      text: "PRIVATE RAW MEMORY TEXT",
      textRef: "box-content://weather-source",
      privacyClass: "private",
      freshnessClass: "current",
      source: "consolidation-cycle",
      origins: [
        { ref_type: "session_id", ref_id: "butler/main" },
        { ref_type: "message_id", ref_id: "msg-1" },
      ],
      boxRefs: [{ box_item_id: box.box_item_id, relation: "evidence" }],
      feedbackRefs: [{ feedback_id: feedback.feedback_id, relation: "user_feedback" }],
      graphRefs: [{ graph_ref_type: "edge", graph_ref_id: "edge_1", relation: "activation" }],
      vectorRefs: [{
        vector_store: "lancedb",
        vector_table: "memories",
        vector_row_id: "row_1",
        embedding_model: "text-embedding-3-large",
        embedding_dimension: 3072,
      }],
      now: new Date("2026-05-15T00:00:00.000Z"),
    });

    expect(existsSync(memoryMetadataPath(butlerData))).toBe(true);
    expect(chunk.memory_chunk_id.startsWith("mem_")).toBe(true);
    expect(chunk.text_hash).toBeTruthy();
    expect(JSON.stringify(chunk)).not.toContain("PRIVATE RAW MEMORY TEXT");
    expect(chunk.origins).toContainEqual({ ref_type: "message_id", ref_id: "msg-1" });
    expect(chunk.box_refs).toEqual([{ box_item_id: box.box_item_id, relation: "evidence" }]);
    expect(chunk.feedback_refs).toEqual([{ feedback_id: feedback.feedback_id, relation: "user_feedback" }]);
    expect(chunk.graph_refs).toEqual([{ graph_ref_type: "edge", graph_ref_id: "edge_1", relation: "activation" }]);
    expect(chunk.vector_refs).toEqual([{
      vector_store: "lancedb",
      vector_table: "memories",
      vector_row_id: "row_1",
      embedding_model: "text-embedding-3-large",
      embedding_dimension: 3072,
      indexed_at: "2026-05-15T00:00:00.000Z",
    }]);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("memory metadata link helpers are idempotent and queryable", () => {
  const butlerData = tempData();
  try {
    const chunk = createMemoryChunk(butlerData, {
      scope: "project",
      projectId: "butler",
      summary: "Project preference summary.",
      source: "feedback-buffer",
    });

    linkMemoryChunkOrigin(butlerData, chunk.memory_chunk_id, { ref_type: "turn_id", ref_id: "turn-1" });
    linkMemoryChunkOrigin(butlerData, chunk.memory_chunk_id, { ref_type: "turn_id", ref_id: "turn-1" });
    linkMemoryChunkBox(butlerData, chunk.memory_chunk_id, { box_item_id: "box_missing", relation: "evidence" });
    linkMemoryChunkFeedback(butlerData, chunk.memory_chunk_id, { feedback_id: "fb_missing", relation: "user_feedback" });
    linkMemoryChunkGraph(butlerData, chunk.memory_chunk_id, { graph_ref_type: "node", graph_ref_id: "node_1", relation: "mentions" });
    linkMemoryChunkVector(butlerData, chunk.memory_chunk_id, {
      vector_store: "lancedb",
      vector_table: "memories",
      vector_row_id: "row_2",
      embedding_model: "embedding-model",
      embedding_dimension: null,
      indexed_at: "2026-05-15T00:05:00.000Z",
    });

    const reread = readMemoryChunkWithRefs(butlerData, chunk.memory_chunk_id);
    expect(reread?.origins).toEqual([{ ref_type: "turn_id", ref_id: "turn-1" }]);
    expect(reread?.box_refs).toEqual([{ box_item_id: "box_missing", relation: "evidence" }]);
    expect(reread?.feedback_refs).toEqual([{ feedback_id: "fb_missing", relation: "user_feedback" }]);
    expect(reread?.graph_refs).toEqual([{ graph_ref_type: "node", graph_ref_id: "node_1", relation: "mentions" }]);
    expect(reread?.vector_refs).toHaveLength(1);
    expect(listMemoryChunks(butlerData).map((item) => item.memory_chunk_id)).toEqual([chunk.memory_chunk_id]);

    const db = new Database(memoryMetadataPath(butlerData), { readonly: true });
    try {
      const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toContain("memory_chunk_vector_refs");
    } finally {
      db.close();
    }
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("memory metadata integrity reports missing Box and feedback refs", () => {
  const butlerData = tempData();
  try {
    createMemoryChunk(butlerData, {
      scope: "global",
      summary: "Missing refs should be repairable later.",
      source: "unit-test",
      boxRefs: [{ box_item_id: "box_missing", relation: "evidence" }],
      feedbackRefs: [{ feedback_id: "fb_missing", relation: "user_feedback" }],
    });

    const report = checkMemoryMetadataIntegrity(butlerData);
    expect(report.chunk_count).toBe(1);
    expect(report.missing_box_refs).toEqual([{ memory_chunk_id: listMemoryChunks(butlerData)[0]?.memory_chunk_id, box_item_id: "box_missing" }]);
    expect(report.missing_feedback_refs).toEqual([{ memory_chunk_id: listMemoryChunks(butlerData)[0]?.memory_chunk_id, feedback_id: "fb_missing" }]);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
