import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppStoreKernel } from "../../packages/butler-agent/src/gateways/app/application/kernel/app-store-kernel.ts";
import { EMPTY_STEWARD_OBSERVER } from "./support/steward-observer.ts";
import { publishOperation } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-tool-progress.ts";
import { projectTurnProgressToEvents } from "../../packages/butler-agent/src/agent/btcc/projection/turn-progress.ts";
import { progressRowFromSharedTurnEvent, type SharedTurnEvent } from "../../packages/butler-progress-projection/src/index.ts";
import { normalizeProgressSummaryRow } from "../../packages/butler-agent/src/gateways/app/domain/progress-summary/progress-row-normalizer.ts";
import { dedupeProgressRows } from "../../packages/butler-agent/src/gateways/app/domain/progress-summary/progress-row-merge.ts";
import { interfaceProgressLabel, localizeProgressRow, setAppCopyLanguage } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import { formatInterfaceText, readInterfaceContent } from "../../packages/butler-i18n/src/index.ts";

test("actual guided operation emission retains locale-neutral public templates through projection", async () => {
  const events: SharedTurnEvent[] = [];
  const observer = projectTurnProgressToEvents(async event => { events.push({ ...event, id: `event-${events.length}`, turnSequence: events.length + 1 }); });
  await publishOperation(observer, { turnId: "turn", activityId: "activity", requestId: "call", toolName: "read_file", args: { path: "/private/work/src/sample.ts" }, status: "started" });
  const projected = events.map(progressRowFromSharedTurnEvent).find(row => row?.interface_content);
  expect(projected).toBeDefined();
  const row = normalizeProgressSummaryRow(projected!);
  expect(row.interface_content?.title).toEqual({ key: "toolTitle", parameters: { toolName: "read_file", target: "sample.ts" } });
  expect(JSON.stringify(row.interface_content)).not.toContain("/private");
  try {
    setAppCopyLanguage("en");
    expect(interfaceProgressLabel(row)).toBe("Read file: sample.ts");
    setAppCopyLanguage("ko");
    expect(interfaceProgressLabel(row)).toBe("파일 읽기: sample.ts");
    expect(row.safe_label).toBe("Read file: sample.ts");
  } finally { setAppCopyLanguage("en"); }
});

test("templates localize only marked fields and reject unknown payloads", () => {
  const row = { id: "authored", kind: "message", state: "running", safe_label: "한국어 authored text", work_decision_summary: "한국어 authored text", interface_content: { title: { key: "toolTitle" as const, parameters: { toolName: "read_file" } } } };
  expect(localizeProgressRow(row).safe_label).toBe(row.safe_label);
  expect(localizeProgressRow(row).work_decision_summary).toBe(row.work_decision_summary);
  expect(readInterfaceContent({ title: { key: "unknown", parameters: { secret: "value" } } })).toBeUndefined();
  expect(formatInterfaceText({ key: "toolsSummary", parameters: { tools: [{ name: "read_file", target: "a.ts" }] } }, "ko-KR")).toContain("a.ts");
});

test("current sidebar status persists template provenance and clears it for authored replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-i18n-status-"));
  const kernel = new AppStoreKernel({ butlerData: join(root, "data"), butlerHome: root, dbPath: join(root, "app.sqlite"), stewardObserver: EMPTY_STEWARD_OBSERVER });
  try {
    const now = new Date().toISOString();
    kernel.db.query("INSERT INTO chats (id,title,kind,created_at,updated_at) VALUES ('chat','Chat','chat',?,?)").run(now, now);
    kernel.db.query("INSERT INTO turns (id,chat_id,state,safe_status_label,retryable,cancellable,attempt,created_at,updated_at) VALUES ('turn','chat','running','Working',0,1,1,?,?)").run(now, now);
    const content = { title: { key: "toolTitle", parameters: { toolName: "read_file", target: "sample.ts" } } };
    const publish = (row: Record<string, unknown>) => kernel.turnProgress.appendProgressSummaryEvent("chat", "turn", { id: "activity", kind: "tool", state: "running", safe_label: "Read file: sample.ts", ...row });
    publish({ interface_content: content });
    const stored = kernel.db.query("SELECT safe_status_content_json FROM turns WHERE id='turn'").get() as { safe_status_content_json: string };
    expect(JSON.parse(stored.safe_status_content_json)).toEqual(content);
    publish({ id: "authored", safe_label: "사용자 작성 상태" });
    expect(kernel.db.query("SELECT safe_status_content_json FROM turns WHERE id='turn'").get()).toEqual({ safe_status_content_json: null });
  } finally { kernel.close(); rmSync(root, { recursive: true, force: true }); }
});

test("merged status uses the winning label's provenance, including authored replacements", () => {
  const generated = normalizeProgressSummaryRow({ id: "same", tool_call_id: "same-call", kind: "tool", state: "running", safe_label: "Read file", interface_content: { title: { key: "toolTitle", parameters: { toolName: "read_file" } } } });
  const authored = normalizeProgressSummaryRow({ id: "same", tool_call_id: "same-call", kind: "tool", state: "running", safe_label: "직접 작성한 상태" });
  const [replacement] = dedupeProgressRows([generated, authored]);
  expect(replacement!.interface_content).toBeUndefined();
  expect(interfaceProgressLabel(replacement!)).toBe("직접 작성한 상태");
  const completed = { ...generated, state: "delivered" };
  expect(dedupeProgressRows([completed, authored])[0]!.interface_content).toEqual(generated.interface_content);
});
