import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  appendBoxArtifactEvent,
  boxEventsPath,
  boxIndexPath,
  boxIngestQueuePath,
  boxItemRoot,
  boxManifestPath,
  createBoxItem,
  listBoxManifests,
  listIndexedBoxItems,
  rebuildBoxIndex,
  readBoxManifest,
  validateBoxManifest,
  writeBoxBlob,
} from "../../packages/butler-agent/src/agent/cognition/box/store.ts";

function tempData(): string {
  return mkdtempSync(join(tmpdir(), "butler-box-store-"));
}

test("Butler Box creates canonical manifests and box-owned content files", () => {
  const butlerData = tempData();
  try {
    const manifest = createBoxItem(butlerData, {
      kind: "tool_result",
      status: "indexed",
      title: "Weather payload",
      summary: "Weather source response summary.",
      tags: ["weather", "source"],
      origin: {
        producer: "unit-test",
        session_id: "butler/main",
        turn_id: "turn-1",
        message_id: "msg-1",
      },
      source: {
        uri: "https://example.test/weather",
        provider: "example",
        fetched_at: "2026-05-15T00:00:00.000Z",
      },
      content: [{
        filename: "snapshot.json",
        data: JSON.stringify({ temp: 21 }),
        mimeType: "application/json",
      }],
      privacy: {
        class: "public",
        external_provider_allowed: true,
        reason: "public-source",
      },
      freshness: {
        class: "current",
        source_timestamp: "2026-05-15T00:00:00.000Z",
      },
      refs: {
        feedback_ids: ["fb_unit"],
        knowhow_ids: ["kh_unit"],
      },
      now: new Date("2026-05-15T00:01:00.000Z"),
    });

    expect(validateBoxManifest(manifest, manifest.box_item_id)).toEqual([]);
    expect(existsSync(boxManifestPath(butlerData, manifest.box_item_id))).toBe(true);
    expect(readFileSync(join(boxItemRoot(butlerData, manifest.box_item_id), "content", "snapshot.json"), "utf8")).toContain("\"temp\":21");
    expect(readBoxManifest(butlerData, manifest.box_item_id)?.refs.feedback_ids).toEqual(["fb_unit"]);
    expect(listBoxManifests(butlerData).map((item) => item.box_item_id)).toEqual([manifest.box_item_id]);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("Butler Box appends lightweight artifact events and ingest queue entries", () => {
  const butlerData = tempData();
  try {
    const event = appendBoxArtifactEvent(butlerData, {
      origin: {
        session_id: "butler/main",
        turn_id: "turn-2",
        message_id: "msg-2",
      },
      artifacts: [{
        kind: "file",
        path: "/tmp/report.md",
        ownership: "external-user-owned",
      }],
      now: new Date("2026-05-15T00:02:00.000Z"),
    });

    expect(event.artifact_event_id.startsWith("artev_")).toBe(true);
    const eventLine = JSON.parse(readFileSync(boxEventsPath(butlerData), "utf8").trim());
    const queueLine = JSON.parse(readFileSync(boxIngestQueuePath(butlerData), "utf8").trim());
    expect(eventLine).toEqual(event);
    expect(queueLine).toEqual(event);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("Butler Box stores content-addressed blobs without duplicate writes", () => {
  const butlerData = tempData();
  try {
    const first = writeBoxBlob(butlerData, "same payload");
    const second = writeBoxBlob(butlerData, "same payload");
    expect(first.sha256).toBe(second.sha256);
    expect(first.box_relative_path).toBe(second.box_relative_path);
    expect(existsSync(first.path)).toBe(true);
    expect(readFileSync(first.path, "utf8")).toBe("same payload");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("Butler Box rebuilds SQLite index from manifests and skips invalid items", () => {
  const butlerData = tempData();
  try {
    const manifest = createBoxItem(butlerData, {
      kind: "report",
      title: "Daily report",
      summary: "Short report summary.",
      tags: ["daily"],
      origin: { producer: "unit-test", session_id: "butler/main" },
      content: [{ filename: "report.md", data: "# Report\n", mimeType: "text/markdown" }],
      refs: { memory_chunk_ids: ["mem_unit"], graph_edge_ids: ["edge_unit"] },
      now: new Date("2026-05-15T00:03:00.000Z"),
    });
    const invalidRoot = boxItemRoot(butlerData, "box_invalid");
    mkdirSync(invalidRoot, { recursive: true });
    writeFileSync(join(invalidRoot, "manifest.json"), JSON.stringify({
      schema: "wrong",
      box_item_id: "box_invalid",
      kind: "nope",
      status: "pending",
      privacy: { class: "private" },
      retention: { class: "working" },
      freshness: { class: "unknown" },
      files: [],
    }), "utf8");

    const report = rebuildBoxIndex(butlerData);
    expect(report).toMatchObject({ status: "partial", indexed_count: 1, skipped_count: 1 });
    expect(existsSync(boxIndexPath(butlerData))).toBe(true);
    expect(listIndexedBoxItems(butlerData).map((item) => item.box_item_id)).toEqual([manifest.box_item_id]);

    const db = new Database(boxIndexPath(butlerData), { readonly: true });
    try {
      const origin = db.query("SELECT ref_type, ref_id FROM box_item_origins WHERE box_item_id = ?").all(manifest.box_item_id);
      const refs = db.query("SELECT ref_type, ref_id, relation FROM box_item_refs WHERE box_item_id = ? ORDER BY ref_type").all(manifest.box_item_id);
      const tags = db.query("SELECT tag FROM box_item_tags WHERE box_item_id = ?").all(manifest.box_item_id);
      expect(origin).toContainEqual({ ref_type: "session_id", ref_id: "butler/main" });
      expect(refs).toContainEqual({ ref_type: "memory_chunk", ref_id: "mem_unit", relation: "evidence" });
      expect(refs).toContainEqual({ ref_type: "graph_edge", ref_id: "edge_unit", relation: "graph_evidence" });
      expect(tags).toEqual([{ tag: "daily" }]);
    } finally {
      db.close();
    }
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
