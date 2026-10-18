// The owner-approved D5 trace as GET /logs/trace returns it: a send that hit
// 429, waited, got 200 with one tool call to a researcher sub-agent whose MCP
// request sits at depth 5. Only the rendering is under test here; the agent's
// own projection is covered by the TRACE-* E2E tests.
export const FIXTURE_TRACE_ID = "d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5";

type Span = {
  span_id: string; parent_span_id: string | null; name: string; category: string; process: string;
  start_offset_ms: number; duration_ms: number | null; status: "ok" | "error" | "wait" | "warn";
  tone: "model" | "tool" | "app" | "agent" | "error" | "wait"; title: string; child_count: number;
  has_details: boolean; attrs: Record<string, unknown>;
};

let next = 0;
function span(parent: string | null, name: string, offset: number, duration: number, tone: Span["tone"],
  attrs: Record<string, unknown> = {}, status: Span["status"] = "ok"): Span {
  next += 1;
  return {
    span_id: `d5${String(next).padStart(14, "0")}`, parent_span_id: parent, name, category: name.split(".")[0]!,
    process: tone === "app" ? "app" : "agent", start_offset_ms: offset, duration_ms: duration, status, tone,
    title: name, child_count: 0, has_details: false, attrs,
  };
}

function build(): Span[] {
  const spans: Span[] = [];
  const add = (...args: Parameters<typeof span>) => { const value = span(...args); spans.push(value); return value.span_id; };
  add(null, "http.request", 0, 4, "app", { method: "POST", route: "/messages", status: 202 });
  add(null, "turn.deliver", 4, 18, "app", { final_action: true });
  const turn = add(null, "turn.run", 22, 9818, "agent", { model: "gemini-3-pro", turn_id: "turn_01JB7Q4M2X" });
  add(turn, "route.select", 30, 6, "agent");
  add(turn, "context.build", 36, 132, "agent", { sections: 9, tokens: 14050 });
  const first = add(turn, "model.request", 168, 412, "error", { attempt: 1, attempts: 3 }, "error");
  add(first, "http.request", 170, 408, "error", {
    method: "POST", host: "generativelanguage.googleapis.com", path: "/v1beta/models/gemini-3-pro:streamGenerateContent",
    status: 429, purpose: "execution", request_headers: { authorization: "[redacted]" },
  }, "error");
  add(turn, "retry.wait", 580, 2000, "wait", { delay_ms: 2000, reason: "RESOURCE_EXHAUSTED" }, "wait");
  const second = add(turn, "model.request", 2580, 3150, "model", { attempt: 2, attempts: 3 });
  const http = add(second, "http.request", 2582, 3146, "model", {
    method: "POST", host: "generativelanguage.googleapis.com", path: "/v1beta/models/gemini-3-pro:streamGenerateContent",
    status: 200, first_byte_ms: 1080,
  });
  add(http, "stream.receive", 3662, 2066, "model", { chunks: 31 });
  const tool = add(turn, "tool.call", 5740, 3720, "tool", { name: "ask_researcher" });
  const sub = add(tool, "turn.run", 5752, 3690, "agent", { model: "openai/gpt-6-luna", turn_id: "turn_01JB7Q4R9K" });
  add(sub, "model.request", 5760, 352, "model", { attempt: 1, attempts: 3 });
  const search = add(sub, "tool.call", 6120, 2410, "tool", { name: "docs.search" });
  const mcp = add(search, "mcp.call", 6126, 2398, "tool", { method: "tools/call" });
  add(mcp, "http.request", 6131, 2380, "tool", { method: "POST", host: "127.0.0.1", path: "/mcp", status: 200 });
  add(sub, "model.request", 8540, 890, "model", { attempt: 1, attempts: 3 });
  add(turn, "model.request", 9470, 330, "model", { attempt: 1, attempts: 3 });
  add(turn, "memory.write", 9800, 40, "agent");
  for (const value of spans) value.child_count = spans.filter((child) => child.parent_span_id === value.span_id).length;
  return spans;
}

export function fixtureTrace(): Record<string, unknown> {
  next = 0;
  return {
    trace_id: FIXTURE_TRACE_ID, started_at: new Date(Date.now() - 60_000).toISOString(), duration_ms: 9840,
    outcome: "ok", model: "gemini-3-pro", chat_id: "general", turn_id: "turn_01JB7Q4M2X", spans: build(),
    truncated: false, scanned_bytes: 4096,
  };
}

/** A log row that leads to the fixture trace (메시지 전체 보기). */
export function fixtureTraceRow(): Record<string, unknown> {
  return {
    ts: new Date(Date.now() - 500).toISOString(), level: "INFO", process: "agent", category: "smoke.trace",
    event: "smoke.trace", msg: "Smoke traced row", trace_id: FIXTURE_TRACE_ID, attrs: {},
  };
}
