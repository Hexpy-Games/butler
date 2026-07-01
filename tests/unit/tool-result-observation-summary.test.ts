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
