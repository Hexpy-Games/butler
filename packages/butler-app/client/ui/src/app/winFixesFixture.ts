import { HARNESS_SS03_SUMMARY, HARNESS_SS03_OBSERVER_VIEW } from "./fixtures.ts";
import { projectTurnActivity } from "./conversation-progress/index.ts";
import type { ProgressRow, SessionView } from "./types.ts";

const operation = (id: string, name: string, input: string): ProgressRow => ({
  id, kind: "used_tool", state: "delivered", bridge_phase: "btcc_operation", safe_label: name,
  safe_tool_name: name, safe_input_label: input, tool_call_id: id, tool_result_id: `${id}-result`,
  work_block_id: "tools",
});
export const WIN_FIXES_ROWS = [
  operation("read-one", "read_file", "index.html, index.html"),
  operation("read-two", "read_file", "index.html"),
  operation("command", "run_command", 'node -e "console.log(42)"'),
  operation("powershell", "run_command", 'powershell -NoProfile -Command "Get-ChildItem ."'),
  operation("cmd", "run_command", 'cmd /c "node --version"'),
  operation("write", "write_file", "index.html"),
  operation("memory", "recall_memory", ""),
  operation("ledger", "project_ledger_status", ""),
];
export const WIN_FIXES_PARENT: SessionView = {
  ...HARNESS_SS03_OBSERVER_VIEW, session_id: "butler-client", relation: undefined,
  parent_session_id: undefined, active_turn: null, workers: [], status: "idle",
  latest_turn: { ...HARNESS_SS03_OBSERVER_VIEW.latest_turn!, id: "parent-turn", state: "delivered",
    progress: { safe_progress_rows: [] } },
  steward_children: HARNESS_SS03_SUMMARY.steward_children,
  messages: [{ id: "harness-parent-user", chat_id: "butler-client", role: "user", text: "파일을 확인하고 작업을 진행해 주세요.",
    status: "delivered", created_at: "2026-05-01T00:00:00Z" },
  { id: "parent-answer", chat_id: "butler-client", role: "assistant", text: "파일 확인을 마쳤습니다. 위임 작업이 진행 중입니다.",
    status: "delivered", turn_id: HARNESS_SS03_SUMMARY.steward_children![0]!.relation.parent_turn_id,
    created_at: "2026-05-01T00:00:01Z", work_blocks: projectTurnActivity([
      { id: "tools-start", kind: "work_block", state: "running", safe_label: "파일 확인", work_block_id: "tools", work_block_label: "파일 확인", work_block_phase: "started" },
      ...WIN_FIXES_ROWS,
      { id: "tools-end", kind: "work_block", state: "delivered", safe_label: "파일 확인", work_block_id: "tools", work_block_label: "파일 확인", work_block_phase: "completed" },
    ], "parent-turn").workBlocks,
    changed_files: [{ path: "index.html", additions: 1, deletions: 1,
      lines: [{ type: "deleted", old_line: 1, content: "<title>Old</title>" }, { type: "added", new_line: 1, content: "<title>Butler</title>" }] }] }],
};

