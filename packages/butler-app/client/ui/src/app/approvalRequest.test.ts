import { expect, test } from "bun:test";
import { getAppCopy } from "./copy.ts";
import { approvalRequestView, normalizeApprovalSummary } from "./approvalRequest.ts";
import type { ApprovalSummary, AuthorityApprovalCard } from "./types.ts";

const en = getAppCopy("en-US").interfaceTemplates.approvalRequest;
const ko = getAppCopy("ko-KR").interfaceTemplates.approvalRequest;
const legacyScope = { title: "작업 폴더의 파일 편집", description: "garden 안의 파일 쓰기·수정" };

function card(approval?: ApprovalSummary, overrides: Partial<AuthorityApprovalCard> = {}): AuthorityApprovalCard {
  return {
    requestRef: "request-one", category: "reviewed_effect", reason: "Reviewed operation", executable: "write_file",
    commandCount: 1, scope: legacyScope, ...(approval ? { approval } : {}), ...overrides,
  };
}

type TransportTarget = { kind: string; path: string };

/** A request's `approval` as #277 sends it, narrowed the way the store does. */
function summary(actionKind: string, fields: { targets?: TransportTarget[]; count?: number; examples?: string[];
  risk?: string } = {}): ApprovalSummary {
  const { targets = [], count = 1, examples = [], ...rest } = fields;
  return normalizeApprovalSummary({ action_kind: actionKind, targets, count, examples,
    risk: "risk" in fields ? rest.risk : "medium" })!;
}

/** #277's folder target: its path is the folder label (`garden`, `garden/app`). */
const folder = (label: string) => ({ kind: "folder", path: label });

test("each action kind reads as one question in English and Korean", () => {
  const cases: Array<[ApprovalSummary, string, string]> = [
    [summary("edit_files", { targets: [folder("garden"), { kind: "file", path: "a.md" }, { kind: "file", path: "b.md" }], count: 2 }),
      "Edit 2 files in 'garden'?", "'garden'의 파일 2개를 수정할까요?"],
    [summary("edit_files", { targets: [folder("garden")], count: 1 }), "Edit 1 file in 'garden'?", "'garden'의 파일 1개를 수정할까요?"],
    [summary("run_command", { targets: [folder("garden/app")], examples: ["npm test"] }),
      "Run a command in 'garden/app'?", "'garden/app'에서 명령을 실행할까요?"],
    [summary("network_command", { targets: [folder("garden")], examples: ["curl https://example.com"] }),
      "Run a command that uses the internet in 'garden'?", "'garden'에서 인터넷을 쓰는 명령을 실행할까요?"],
    [summary("use_connector", { targets: [{ kind: "connector", path: "github/create_issue" }], risk: "high" }),
      "Use create_issue from github?", "github의 create_issue 도구를 사용할까요?"],
    [summary("manage_schedule", { targets: [{ kind: "schedule", path: "automation-1" }] }), "Change a schedule?", "예약 작업을 변경할까요?"],
    [summary("update_project", { targets: [{ kind: "project", path: "ledger:work" }], risk: "low" }),
      "Update the project records?", "프로젝트 기록을 업데이트할까요?"],
    [summary("start_conversation", { risk: "low" }), "Start a new conversation?", "새 대화를 시작할까요?"],
    [summary("restart_service", { targets: [{ kind: "service", path: "butler" }] }), "Restart Butler?", "Butler를 다시 시작할까요?"],
    [summary("create_worktree", { targets: [folder("garden")], risk: "low" }),
      "Create a worktree for this conversation?", "이 대화용 워크트리를 만들까요?"],
    [summary("other", { targets: [{ kind: "other", path: "thing" }] }), "Allow this action?", "이 작업을 허용할까요?"],
  ];
  for (const [approval, english, korean] of cases) {
    expect(approvalRequestView(card(approval), en).title).toBe(english);
    expect(approvalRequestView(card(approval), ko).title).toBe(korean);
  }
});

test("the sentence quotes the workspace label, spaces and all, and drops what is missing", () => {
  const notes = summary("edit_files", { targets: [folder("My Notes")], count: 3 });
  expect(approvalRequestView(card(notes), en).title).toBe("Edit 3 files in 'My Notes'?");
  expect(approvalRequestView(card(notes), ko).title).toBe("'My Notes'의 파일 3개를 수정할까요?");
  const noCount = summary("edit_files", { targets: [folder("garden")], count: 0 });
  expect(approvalRequestView(card(noCount), en).title).toBe("Edit files in 'garden'?");
  expect(approvalRequestView(card(noCount), ko).title).toBe("'garden'의 파일을 수정할까요?");
  const bare = summary("use_connector", { targets: [{ kind: "connector", path: "notion" }] });
  expect(approvalRequestView(card(bare), en).title).toBe("Use notion?");
  expect(approvalRequestView(card(summary("use_connector")), ko).title).toBe("연결된 도구를 사용할까요?");
});

test("without a workspace label the sentence says this workspace", () => {
  for (const targets of [[], [{ kind: "folder", path: "" }], [{ kind: "folder", path: "  " }]]) {
    const edits = summary("edit_files", { targets, count: 24 });
    expect(approvalRequestView(card(edits), en)).toMatchObject({ title: "Edit 24 files in this workspace?",
      conversationScope: "File edits in this workspace" });
    expect(approvalRequestView(card(edits), ko)).toMatchObject({ title: "이 작업 공간의 파일 24개를 수정할까요?",
      conversationScope: "이 작업 공간의 파일 수정" });
    const command = summary("run_command", { targets });
    expect(approvalRequestView(card(command), en).title).toBe("Run a command in this workspace?");
    expect(approvalRequestView(card(command), ko).title).toBe("이 작업 공간에서 명령을 실행할까요?");
  }
  const offline = normalizeApprovalSummary({ action_kind: "network_command", targets: [{ kind: "folder", path: "." }] });
  expect(approvalRequestView(card(offline), en).title).toBe("Run a command that uses the internet in this workspace?");
});

test("up to three examples show, then a +N more line for the rest", () => {
  const edits = summary("edit_files", { targets: [folder("garden")], count: 24,
    examples: ["a.png", "b.png", "c.png", "d.png"] });
  expect(approvalRequestView(card(edits), en).details).toEqual(["a.png", "b.png", "c.png", "+21 more"]);
  expect(approvalRequestView(card(edits), ko).details).toEqual(["a.png", "b.png", "c.png", "외 21개"]);
  const command = summary("run_command", { examples: ["npm test"] });
  expect(approvalRequestView(card(command), en).details).toEqual(["npm test"]);
  // Nothing to count without examples: a connector call is not "+1 more".
  expect(approvalRequestView(card(summary("use_connector")), en).details).toEqual([]);
});

test("long relative paths are cut in the middle and keep the file name", () => {
  const long = "photos/2026/September/holiday trip to the coast/day 3/IMG_20260927_100214.png";
  const edits = summary("edit_files", { targets: [folder("Desktop")], count: 2, examples: [long, "short/a.png"] });
  const [first, second] = approvalRequestView(card(edits), en).details;
  expect(first).toBe("photos/2026/…/IMG_20260927_100214.png");
  expect(second).toBe("short/a.png");
  const longName = `${"x".repeat(60)}.png`;
  const cut = approvalRequestView(card(summary("edit_files", { examples: [`notes/${longName}`] })), en).details[0]!;
  expect(cut.length).toBe(44);
  expect(cut).toMatch(/^notes\/x+…x+\.png$/u);
  // A command line is shown as sent: the person approves exactly what runs.
  const command = `npm run build -- --out ${"dist/".repeat(12)}`;
  expect(approvalRequestView(card(summary("run_command", { examples: [command] })), en).details).toEqual([command]);
});

test("the badge shows the risk the agent sent: the App never classifies commands itself", () => {
  // Fixture-driven: the same command line with each risk the agent may send.
  for (const risk of ["low", "medium", "high"] as const) {
    const push = summary("run_command", { targets: [folder("garden")], examples: ["git push origin main"], risk });
    expect(approvalRequestView(card(push), en).risk).toBe(risk);
  }
  expect(approvalRequestView(card(summary("run_command", { risk: undefined })), en).risk).toBeUndefined();
  expect(en.risk).toEqual({ low: "Low risk", medium: "Medium risk", high: "High risk" });
  expect(ko.risk).toEqual({ low: "위험 낮음", medium: "위험 보통", high: "위험 높음" });
  expect(normalizeApprovalSummary({ action_kind: "run_command", targets: [], count: 1, examples: [], risk: "severe" })?.risk)
    .toBeUndefined();
});

test("#277 folder labels and relative paths read as sent; a stray absolute path never reaches the card", () => {
  const examples = ["shots/a.png", "/Users/mina/Desktop/shots/b.png", "/private/tmp/elsewhere/c.png"];
  const absolute = normalizeApprovalSummary({ action_kind: "edit_files", count: 24, risk: "medium", examples,
    targets: [{ kind: "folder", path: "/Users/mina/Desktop/" }, { kind: "file", path: "/Users/mina/Desktop/shots/a.png" },
      { kind: "file", path: "/private/tmp/elsewhere/c.png" }] });
  const labelled = normalizeApprovalSummary({ action_kind: "edit_files", count: 24, risk: "medium",
    examples: ["shots/a.png", "shots/b.png", "c.png"],
    targets: [{ kind: "folder", path: "Desktop" }, { kind: "file", path: "shots/a.png" }, { kind: "file", path: "c.png" }] });
  for (const approval of [labelled, absolute]) {
    expect(approval!.targets.map(({ kind, path }) => ({ kind, path }))).toEqual([
      { kind: "folder", path: "" }, { kind: "file", path: "shots/a.png" }, { kind: "file", path: "c.png" }]);
    for (const copy of [en, ko]) {
      const view = approvalRequestView(card(approval), copy);
      expect(view.details.slice(0, 3)).toEqual(["shots/a.png", "shots/b.png", "c.png"]);
      expect(JSON.stringify(view)).not.toMatch(/\/Users\/|\/private\/|\/tmp\//u);
    }
    expect(approvalRequestView(card(approval), en).title).toBe("Edit 24 files in 'Desktop'?");
    expect(approvalRequestView(card(approval), ko).title).toBe("'Desktop'의 파일 24개를 수정할까요?");
  }
  const windows = normalizeApprovalSummary({ action_kind: "edit_files", examples: ["C:\\Users\\mina\\Downloads\\a.txt"],
    targets: [{ kind: "folder", path: "C:\\Users\\mina\\Downloads" }] });
  const windowsView = approvalRequestView(card(windows), en);
  expect(windowsView).toMatchObject({ title: "Edit 1 file in 'Downloads'?", details: ["a.txt"] });
  // An absolute folder shows only its last part.
  const pathLabel = normalizeApprovalSummary({ action_kind: "run_command", targets: [{ kind: "folder", path: "/Users/mina/My Notes/" }] });
  expect(approvalRequestView(card(pathLabel), en).title).toBe("Run a command in 'My Notes'?");
});

test("an unknown kind reads as the generic question; no approval falls back to the legacy scope, then the reason", () => {
  const future = summary("delete_universe", { examples: ["x"], risk: "high" });
  expect(approvalRequestView(card(future), en)).toMatchObject({ title: "Allow this action?", details: ["x"], risk: "high", actionKind: "other" });
  expect(approvalRequestView(card(future), ko).title).toBe("이 작업을 허용할까요?");
  const legacy = approvalRequestView(card(), en);
  expect(legacy).toEqual({ title: "작업 폴더의 파일 편집 · garden 안의 파일 쓰기·수정", details: [], actionKind: "other",
    conversationScope: "garden 안의 파일 쓰기·수정" });
  expect(approvalRequestView(card(undefined, { scope: undefined }), en).title).toBe("Reviewed operation");
});

test("\"Always allow in this conversation\" says what it covers in the same terms", () => {
  const edits = summary("edit_files", { targets: [folder("garden")], count: 3 });
  expect(approvalRequestView(card(edits), en).conversationScope).toBe("File edits in 'garden'");
  expect(approvalRequestView(card(edits), ko).conversationScope).toBe("'garden'의 파일 수정");
  const command = summary("run_command", { targets: [folder("garden")] });
  expect(approvalRequestView(card(command), en).conversationScope).toBe("This command in 'garden'");
  expect(approvalRequestView(card(command), ko).conversationScope).toBe("'garden'에서 이 명령 실행");
  expect(approvalRequestView(card(summary("use_connector")), en).conversationScope).toBe("This same action");
  expect(approvalRequestView(card(summary("use_connector")), ko).conversationScope).toBe("같은 작업");
});

test("the transport approval is narrowed fail-soft: bad fields drop, a bad shape drops the whole summary", () => {
  expect(normalizeApprovalSummary({
    action_kind: "edit_files",
    targets: [{ kind: "folder", path: "garden" }, { kind: "file" }, "notes.md", { kind: "file", path: 7 },
      { kind: "file", path: "./notes.md" }],
    count: 4, examples: ["notes.md", 7], risk: "medium", extra: true,
  })).toEqual({
    actionKind: "edit_files",
    targets: [{ kind: "folder", label: "garden", path: "" }, { kind: "file", path: "notes.md" }],
    count: 4, examples: ["notes.md"], risk: "medium",
  });
  for (const value of [undefined, null, "edit_files", [], { action_kind: "" }, { action_kind: "edit_files", count: -1 },
    { action_kind: "edit_files", count: 1.5 }]) {
    expect(normalizeApprovalSummary(value)).toBeUndefined();
  }
  expect(normalizeApprovalSummary({ action_kind: "run_command" })).toEqual({
    actionKind: "run_command", targets: [], count: 1, examples: [],
  });
});

test("pending approvals from the agent keep their structured approval next to the legacy scope", async () => {
  const { useButlerStore } = await import("./store.ts");
  const previousFetch = globalThis.fetch;
  const request = { request_ref: "request-one", category: "reviewed_effect", reason: "Reviewed operation",
    executable: "write_file", command_count: 1, scope: legacyScope };
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: { session_id: "session-a", requests: [
    { ...request, approval: { action_kind: "edit_files", targets: [folder("garden")],
      count: 2, examples: ["a.md"], risk: "medium" } },
    { ...request, request_ref: "request-old" },
  ] } }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  try {
    useButlerStore.setState({ activeChatId: "session-a" });
    expect(await useButlerStore.getState().refreshAuthorityApprovals("session-a")).toBe(true);
    const [structured, legacy] = useButlerStore.getState().authorityApprovals!.cards;
    expect(structured).toMatchObject({ scope: legacyScope, approval: {
      actionKind: "edit_files", targets: [{ kind: "folder", label: "garden", path: "" }], count: 2, examples: ["a.md"], risk: "medium" } });
    expect(legacy!.approval).toBeUndefined();
  } finally {
    globalThis.fetch = previousFetch;
    useButlerStore.setState({ authorityApprovals: null, activeChatId: "draft:chat" });
  }
});
