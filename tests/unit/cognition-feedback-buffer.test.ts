import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  activeFeedbackEntries,
  addFeedbackEntry,
  clearResolvedFeedbackEntries,
  feedbackBufferPath,
  listFeedbackEntries,
  renderFeedbackBufferContext,
  resolveFeedbackEntry,
  writeFeedbackEntries,
} from "../../packages/butler-agent/src/agent/cognition/feedback/buffer.ts";

function tempData(): string {
  return mkdtempSync(join(tmpdir(), "butler-feedback-buffer-"));
}

test("feedback buffer stores parseable markdown entries with durable metadata", () => {
  const butlerData = tempData();
  try {
    const now = new Date("2026-05-15T00:00:00.000Z");
    const entry = addFeedbackEntry(butlerData, {
      text: "이제 그 소스에서는 검색하지 마세요.",
      targetRef: "source:old-weather",
      category: "source_policy",
      scope: "source",
      promotionTarget: "source_quality",
      priority: "critical",
      privacyClass: "private",
      now,
    });

    const entries = listFeedbackEntries(butlerData);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      feedback_id: entry.feedback_id,
      status: "active",
      created_at: "2026-05-15T00:00:00.000Z",
      priority: "critical",
      scope: "source",
      category: "source_policy",
      target_ref: "source:old-weather",
      promotion_target: "source_quality",
      privacy_class: "private",
      text: "이제 그 소스에서는 검색하지 마세요.",
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("feedback buffer normalizes malformed entries instead of dropping them", () => {
  const butlerData = tempData();
  try {
    const path = feedbackBufferPath(butlerData);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, [
      "## not-a-feedback mystery",
      "",
      "- priority: impossible",
      "- privacy_class: unknown",
      "- custom_key: preserved",
      "",
      "원장은 나중에 다시 확인해 주세요.",
      "",
    ].join("\n"), "utf8");

    const [entry] = listFeedbackEntries(butlerData);
    expect(entry?.feedback_id.startsWith("fb_")).toBe(true);
    expect(entry?.status).toBe("needs_clarification");
    expect(entry?.priority).toBe("high");
    expect(entry?.privacy_class).toBe("private");
    expect(entry?.extra_fields?.custom_key).toBe("preserved");
    expect(entry?.text).toBe("원장은 나중에 다시 확인해 주세요.");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("feedback buffer renders only active non-expired feedback for runtime injection", () => {
  const butlerData = tempData();
  try {
    const active = addFeedbackEntry(butlerData, {
      text: "답변 끝에는 군더더기 없는 검증 결과만 붙이세요.",
      targetRef: "persona:style",
      category: "style",
      scope: "global",
      promotionTarget: "persona",
      priority: "high",
      now: new Date("2026-05-15T00:00:00.000Z"),
    });
    const expired = addFeedbackEntry(butlerData, {
      text: "만료된 피드백",
      targetRef: "tool:web-search",
      category: "tool_policy",
      scope: "tool",
      promotionTarget: "toolchain_prompt",
      priority: "critical",
      now: new Date("2026-05-14T00:00:00.000Z"),
    });
    const resolved = addFeedbackEntry(butlerData, {
      text: "이미 반영된 피드백",
      targetRef: "memory:profile",
      now: new Date("2026-05-14T00:00:00.000Z"),
    });
    const entries = listFeedbackEntries(butlerData).map((entry) => {
      if (entry.feedback_id === expired.feedback_id) {
        return { ...entry, expires_at: "2026-05-14T12:00:00.000Z" };
      }
      return entry;
    });
    writeFeedbackEntries(butlerData, entries);
    resolveFeedbackEntry(butlerData, resolved.feedback_id, "applied", new Date("2026-05-15T00:01:00.000Z"));

    const activeEntries = activeFeedbackEntries(butlerData, new Date("2026-05-15T01:00:00.000Z"));
    expect(activeEntries.map((entry) => entry.feedback_id)).toEqual([active.feedback_id]);

    const context = renderFeedbackBufferContext({ butlerData, maxEntries: 5 });
    expect(context).toContain("## Active Feedback Buffer");
    expect(context).toContain("답변 끝에는 군더더기 없는 검증 결과만 붙이세요.");
    expect(context).not.toContain("만료된 피드백");
    expect(context).not.toContain("이미 반영된 피드백");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("feedback buffer resolves and clears only graduated entries", () => {
  const butlerData = tempData();
  try {
    const active = addFeedbackEntry(butlerData, { text: "아직 남을 피드백", targetRef: "global" });
    const applied = addFeedbackEntry(butlerData, { text: "반영된 피드백", targetRef: "global" });
    const unclear = addFeedbackEntry(butlerData, { text: "분류 불가", targetRef: "global" });

    resolveFeedbackEntry(butlerData, applied.feedback_id, "applied");
    resolveFeedbackEntry(butlerData, unclear.feedback_id, "needs_clarification");
    const result = clearResolvedFeedbackEntries(butlerData);

    expect(result).toEqual({ removed: 1, remaining: 2 });
    expect(listFeedbackEntries(butlerData).map((entry) => entry.feedback_id)).toEqual([
      active.feedback_id,
      unclear.feedback_id,
    ]);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
