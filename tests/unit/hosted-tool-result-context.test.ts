import { expect, test } from "bun:test";
import {
  compactObservedHostedToolMessages,
  hostedToolResultContent,
} from "../../packages/butler-agent/src/integrations/providers/shared/hosted-tool-result-context.ts";

test("hosted work-block results return structured decision repair feedback", () => {
  const content = hostedToolResultContent({
    payload: {
      ok: true,
      output: {
        butler_work_block_result: true,
        decision_feedback: {
          status: "repaired",
          correction: "Keep block_title distinct from objective.",
        },
        results: [{ name: "read_file", args: { path: "src/a.ts" }, ok: true, output: { ok: true } }],
      },
    },
    toolName: "run_work_block",
    log: () => {},
  });

  expect(JSON.parse(content).output.decision_feedback).toEqual({
    status: "repaired",
    correction: "Keep block_title distinct from objective.",
  });
});

test("hosted work-block failures preserve the audited model observation", () => {
  const content = hostedToolResultContent({
    payload: {
      ok: true,
      output: {
        butler_work_block_result: true,
        results: [{
          name: "run_command",
          args: { command: "bun test" },
          ok: false,
          output: {
            ok: false,
            observation_kind: "test_failed",
            summary: "run_command exited with code 1.",
            model_visible_content: "Expected EMPTY_PAGE but received INVALID_PROMPT.",
          },
        }],
      },
    },
    toolName: "run_work_block",
    log: () => {},
  });

  const result = JSON.parse(content).output.results[0];
  expect(result.ok).toBe(false);
  expect(result.result.output.observation_kind).toBe("test_failed");
  expect(result.result.output.model_visible_content).toContain("EMPTY_PAGE");
  expect(JSON.stringify(result)).not.toContain("unknown tool error");
});

test("hosted command compaction keeps failure diagnostics from both ends", () => {
  const content = hostedToolResultContent({
    payload: {
      ok: false,
      output: {
        ok: false,
        observation_kind: "test_failed",
        model_visible_content: `first failure\n${"noise ".repeat(3_000)}\nExpected article but received main`,
      },
    },
    toolName: "run_command",
    log: () => {},
  });

  const preview = JSON.parse(content).output.preview;
  expect(preview.observation_kind).toBe("test_failed");
  expect(preview.model_visible_content).toContain("first failure");
  expect(preview.model_visible_content).toContain("Expected article but received main");
});

test("hosted artifact rehydration compaction keeps the requested output slice", () => {
  const content = hostedToolResultContent({
    payload: {
      ok: true,
      output: {
        ok: true,
        artifact: { id: "tool-output-1", command: "bun test", raw_tokens: 4_000 },
        stdout: {
          text: `test prelude\n${"passing case\n".repeat(500)}13 pass\n1 fail`,
          start_line: 0,
          returned_lines: 503,
          total_lines: 503,
          truncated_by_lines: false,
          truncated_by_tokens: false,
        },
        stderr: {
          text: "Expected: angle brackets\nReceived: opening brackets",
          start_line: 0,
          returned_lines: 2,
          total_lines: 2,
          truncated_by_lines: false,
          truncated_by_tokens: false,
        },
      },
    },
    toolName: "read_tool_output_artifact",
    log: () => {},
  });

  const preview = JSON.parse(content).output.preview;
  expect(preview.tool_name).toBe("read_tool_output_artifact");
  expect(preview.stdout.text).toContain("test prelude");
  expect(preview.stdout.text).toContain("13 pass\n1 fail");
  expect(preview.stderr.text).toContain("Expected: angle brackets");
});

test("observed work-block compaction preserves nested continuation coordinates", () => {
  const assistant = {
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "call-work-block",
      function: {
        name: "run_work_block",
        arguments: JSON.stringify({
          decision: {
            block_title: "Close Ledger records",
            objective: "Close the existing task records after validation.",
            next_step: "Prepare the final report.",
            expected_effect: "All records are complete.",
          },
          calls: [{
            name: "project_ledger_task_complete",
            args: {
              id: "T-APP-WEB-CAPTURE-03",
              status: "completed",
              content: "large private task body that must not survive compaction",
            },
          }, {
            name: "run_command",
            args: {
              command: "bun test --secret-value",
              validation_suite: "browser_capture_tests",
              output_mode: "full",
            },
          }],
        }),
      },
    }],
  };
  const tool = {
    role: "tool",
    name: "run_work_block",
    tool_call_id: "call-work-block",
    content: JSON.stringify({
      ok: true,
      output: {
        result: "x".repeat(20_000),
      },
    }),
  };
  const messages = [assistant, tool];

  expect(compactObservedHostedToolMessages({ messages, log: () => {} })).toBeGreaterThan(0);
  const compact = JSON.parse(assistant.tool_calls[0]!.function.arguments);

  expect(compact.decision.block_title).toBe("Close Ledger records");
  expect(compact.calls).toEqual([
    {
      name: "project_ledger_task_complete",
      args: { id: "T-APP-WEB-CAPTURE-03", status: "completed" },
    },
    {
      name: "run_command",
      args: { validation_suite: "browser_capture_tests", output_mode: "full" },
    },
  ]);
  expect(assistant.tool_calls[0]!.function.arguments).not.toContain("secret-value");
  expect(assistant.tool_calls[0]!.function.arguments).not.toContain("private task body");
});
