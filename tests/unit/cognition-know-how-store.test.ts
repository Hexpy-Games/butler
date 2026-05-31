import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { addFeedbackEntry } from "../../packages/butler-agent/src/agent/cognition/feedback/buffer.ts";
import {
  aggregateSourceQuality,
  createKnowHowEntry,
  knowHowIndexPath,
  listKnowHowEntries,
  recordSourceQualityEvent,
  rebuildKnowHowIndex,
  retrieveKnowHow,
} from "../../packages/butler-agent/src/agent/cognition/know-how/store.ts";

function tempData(): string {
  return mkdtempSync(join(tmpdir(), "butler-know-how-"));
}

test("generic know-how store creates entries and retrieves by aliases topics and examples", () => {
  const butlerData = tempData();
  try {
    const entry = createKnowHowEntry(butlerData, {
      name: "weather_source_lookup",
      aliases: ["날씨찾기", "weather"],
      status: "active",
      summary: "Use live weather sources before generic routing.",
      intent_match: {
        topics: ["weather", "forecast"],
        examples: ["오늘 날씨 어때?", "서울 비 와?"],
      },
      strategy: {
        steps: ["resolve location", "fetch preferred source"],
        preferred_sources: ["open-meteo"],
      },
      quality: {
        score: 0.8,
        confidence: 0.75,
        success_count: 2,
        failure_count: 0,
        negative_feedback_count: 0,
        last_used_at: "2026-05-15T00:00:00.000Z",
        last_validated_at: "2026-05-15T00:00:00.000Z",
      },
      now: new Date("2026-05-15T00:00:00.000Z"),
    });

    expect(listKnowHowEntries(butlerData).map((item) => item.knowhow_id)).toEqual([entry.knowhow_id]);
    const result = retrieveKnowHow({ butlerData, query: "오늘 서울 날씨 어때?" });
    expect(result.selected?.knowhow_id).toBe(entry.knowhow_id);
    expect(result.candidates[0]?.final_score).toBeGreaterThan(0);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("generic know-how retrieval suppresses candidates from immediate feedback buffer", () => {
  const butlerData = tempData();
  try {
    const entry = createKnowHowEntry(butlerData, {
      name: "weather_source_lookup",
      aliases: ["weather"],
      status: "active",
      summary: "Use a weather source.",
      intent_match: { topics: ["weather"], examples: ["today weather"] },
      strategy: { steps: ["fetch source"], preferred_sources: ["bad-source"] },
      quality: {
        score: 0.9,
        confidence: 0.8,
        success_count: 3,
        failure_count: 0,
        negative_feedback_count: 0,
        last_used_at: null,
        last_validated_at: null,
      },
    });
    const feedback = addFeedbackEntry(butlerData, {
      text: "이제 bad-source에서는 검색하지 마세요.",
      targetRef: "source:bad-source",
      category: "source_policy",
      promotionTarget: "source_quality",
    });

    const result = retrieveKnowHow({ butlerData, query: "weather now" });
    expect(result.selected).toBeNull();
    expect(result.candidates[0]?.entry.knowhow_id).toBe(entry.knowhow_id);
    expect(result.candidates[0]?.suppressed_by_feedback_ids).toEqual([feedback.feedback_id]);
    expect(result.candidates[0]?.final_score).toBe(0);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("source quality events aggregate freshness success feedback and latency", () => {
  const butlerData = tempData();
  try {
    recordSourceQualityEvent(butlerData, {
      source_id: "open-meteo",
      source_uri: "https://api.open-meteo.com",
      tool_name: "weather",
      observed_at: "2026-05-15T00:00:00.000Z",
      task_kind: "weather",
      freshness_score: 1,
      success: true,
      latency_ms: 200,
      user_feedback: "none",
      box_item_id: "box_1",
      feedback_id: null,
      consolidation_run_id: null,
    });
    recordSourceQualityEvent(butlerData, {
      source_id: "open-meteo",
      source_uri: "https://api.open-meteo.com",
      tool_name: "weather",
      observed_at: "2026-05-15T00:05:00.000Z",
      task_kind: "weather",
      freshness_score: 0.6,
      success: false,
      latency_ms: 800,
      user_feedback: "negative",
      box_item_id: "box_2",
      feedback_id: "fb_1",
      consolidation_run_id: null,
    });

    const [summary] = aggregateSourceQuality(butlerData);
    expect(summary).toMatchObject({
      source_id: "open-meteo",
      tool_name: "weather",
      event_count: 2,
      success_count: 1,
      failure_count: 1,
      negative_feedback_count: 1,
      average_freshness_score: 0.8,
      average_latency_ms: 500,
      last_observed_at: "2026-05-15T00:05:00.000Z",
    });
    expect(summary?.score).toBeGreaterThan(0);
    expect(summary?.score).toBeLessThan(1);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("know-how index is rebuildable from entries and source-quality events", () => {
  const butlerData = tempData();
  try {
    const entry = createKnowHowEntry(butlerData, {
      name: "news_lookup",
      aliases: ["뉴스찾기"],
      status: "candidate",
      summary: "Find live news sources.",
      intent_match: { topics: ["news"], examples: ["오늘 주요 뉴스"] },
      strategy: { steps: ["fetch live source"], preferred_sources: ["news-source"] },
    });
    recordSourceQualityEvent(butlerData, {
      source_id: "news-source",
      source_uri: "https://news.example.test",
      tool_name: "news",
      observed_at: "2026-05-15T00:10:00.000Z",
      task_kind: "news",
      freshness_score: 0.9,
      success: true,
      latency_ms: 100,
      user_feedback: "positive",
      box_item_id: null,
      feedback_id: null,
      consolidation_run_id: null,
    });

    const report = rebuildKnowHowIndex(butlerData);
    expect(report).toMatchObject({ indexed_count: 1, source_quality_count: 1 });
    expect(existsSync(knowHowIndexPath(butlerData))).toBe(true);

    const db = new Database(knowHowIndexPath(butlerData), { readonly: true });
    try {
      const indexed = db.query("SELECT knowhow_id, name FROM knowhow_entries").get() as { knowhow_id: string; name: string };
      const term = db.query("SELECT term, kind FROM knowhow_terms WHERE knowhow_id = ? AND kind = 'alias'").get(entry.knowhow_id);
      const quality = db.query("SELECT source_id, event_count FROM source_quality_scores").get();
      expect(indexed).toEqual({ knowhow_id: entry.knowhow_id, name: "news_lookup" });
      expect(term).toEqual({ term: "뉴스찾기", kind: "alias" });
      expect(quality).toEqual({ source_id: "news-source", event_count: 1 });
    } finally {
      db.close();
    }
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
