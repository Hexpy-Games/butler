import { expect, test } from "bun:test";
import { summarizedToolResultForObservation } from "../../packages/butler-agent/src/agent/turn/native/tool-execution/tool-result-observation-summary.ts";

test("tool result observation summary exposes Project Ledger recovery hints without private paths", () => {
  const summary = summarizedToolResultForObservation({
    ok: false,
    error: {
      code: "invalid_transition",
      message: "Invalid work transition for file:///Users/sandy/Secret Project/work.md",
      details: [
        {
          id: "W-SANDY",
          kind: "work",
          status: "in_progress",
          message: "Record came from path:/run/user/501/Secret Project/work.md",
        },
      ],
      next: [
        {
          command: "project-ledger work update --project /home/sandy/Secret Project/.butler/project-ledger/projects/sandy --id W-SANDY --status review",
          reason: "Transition before retrying from /tmp/butler-ledger",
        },
      ],
      native_next: [
        {
          tool: "project_ledger_work_update",
          args: {
            id: "W-SANDY",
            status: "review",
            project_path: "/Users/sandy/Secret Project/.butler/project-ledger/projects/sandy",
          },
          reason: "Retry with the native tool instead of /private/var/manual-edit",
        },
      ],
    },
  });

  expect(summary).toContain("error.code: invalid_transition");
  expect(summary).toContain("Invalid work transition for [redacted-path]");
  expect(summary).toContain("detail: message: Record came from path:[redacted-path], id: W-SANDY, kind: work, status: in_progress");
  expect(summary).toContain("next: project-ledger work update --project [redacted-path] --id W-SANDY --status review");
  expect(summary).toContain("Transition before retrying from [redacted-path]");
  expect(summary).toContain("native_next: project_ledger_work_update");
  expect(summary).toContain("project_path: [redacted-path]");
  expect(summary).not.toContain("/home/sandy");
  expect(summary).not.toContain("/run/user");
  expect(summary).not.toContain("/tmp/butler");
  expect(summary).not.toContain("/Users/sandy");
  expect(summary).not.toContain("/private/var");
  expect(summary).not.toContain("file:///Users");
  expect(summary).not.toContain("Secret Project");
});

test("tool result observation summary redacts sensitive native-next argument values", () => {
  const summary = summarizedToolResultForObservation({
    ok: false,
    error: {
      code: "completion_gate_failed",
      message: "Work completion gate failed: validation, report",
      native_next: [
        {
          tool: "project_ledger_work_complete",
          args: {
            id: "W-SANDY",
            token: "abc123opaque",
            api_key: "sk_live_abc123",
            authorization: "Bearer secret",
            github_token: "ghp_secret",
            openai_api_key: "sk_secret",
            db_password: "db_secret",
          },
          reason: "Add missing completion evidence fields.",
        },
      ],
    },
  });

  expect(summary).toContain("error.code: completion_gate_failed");
  expect(summary).toContain("native_next: project_ledger_work_complete");
  expect(summary).toContain("token: [redacted]");
  expect(summary).toContain("api_key: [redacted]");
  expect(summary).toContain("authorization: [redacted]");
  expect(summary).toContain("github_token: [redacted]");
  expect(summary).toContain("openai_api_key: [redacted]");
  expect(summary).toContain("db_password: [redacted]");
  expect(summary).not.toContain("abc123opaque");
  expect(summary).not.toContain("sk_live_abc123");
  expect(summary).not.toContain("Bearer secret");
  expect(summary).not.toContain("ghp_secret");
  expect(summary).not.toContain("sk_secret");
  expect(summary).not.toContain("db_secret");
});

test("tool result observation summary exposes Project Ledger closeout failure repair hints", () => {
  const summary = summarizedToolResultForObservation({
    ok: false,
    recoverable: true,
    observation_kind: "validation_failed",
    error: {
      code: "project_ledger_closeout_failed",
      message: "Project Ledger lifecycle closeout failed after a successful mutation.",
      details: [
        {
          code: "render_failed",
          kind: "project_ledger_closeout",
          id: "handoff",
          status: "failed",
          message: "Project Ledger generated view render failed.",
        },
        {
          code: "check_failed",
          kind: "project_ledger_closeout",
          status: "failed",
          message: "Project Ledger check failed.",
        },
      ],
      native_next: [
        {
          tool: "project_ledger_render",
          args: { view: "handoff", write: true },
          reason: "Rewrite the failed generated Project Ledger view after index succeeds.",
        },
        {
          tool: "project_ledger_check",
          args: {},
          reason: "Review issues, repair source records, and rerun strict validation.",
        },
      ],
    },
  });

  expect(summary).toContain("error.code: project_ledger_closeout_failed");
  expect(summary).toContain("detail: code: render_failed, message: Project Ledger generated view render failed., id: handoff, kind: project_ledger_closeout, status: failed");
  expect(summary).toContain("native_next: project_ledger_render");
  expect(summary).toContain("view: handoff");
  expect(summary).toContain("native_next: project_ledger_check");
});

test("tool result observation summary exposes Project Ledger check issues", () => {
  const summary = summarizedToolResultForObservation({
    ok: false,
    data: {
      issueCount: 2,
      issues: [
        {
          code: "stale_view",
          severity: "warning",
          message: "Generated view is older than source records",
          path: "/Users/sandy/.butler/project-ledger/projects/butler/views/dashboard.md",
        },
        {
          code: "invalid_reference",
          severity: "error",
          message: "Task parent does not exist",
          record: "T-WEB-CAPTURE",
        },
      ],
    },
    error: {
      code: "project_ledger_check_failed",
      message: "Project Ledger check failed with 2 issues",
    },
  });

  expect(summary).toContain("data.issueCount: 2");
  expect(summary).toContain("issue: code: stale_view, severity: warning");
  expect(summary).toContain("path: [redacted-path]");
  expect(summary).toContain("issue: code: invalid_reference, severity: error");
  expect(summary).toContain("record: T-WEB-CAPTURE");
  expect(summary).not.toContain("/Users/sandy");
});

test("tool result observation summary preserves nested command stderr for repair", () => {
  const summary = summarizedToolResultForObservation({
    ok: false,
    output: {
      ok: false,
      exit_code: 1,
      stdout: "1 test failed",
      stderr: "ReferenceError: document is not defined",
    },
  });

  expect(summary).toContain("output.exit_code: 1");
  expect(summary).toContain("output.stdout: 1 test failed");
  expect(summary).toContain("output.stderr: ReferenceError: document is not defined");
});
