import { expect, test } from "bun:test";
import {
  applyProjectLedgerLifecycleCloseout,
  runProjectLedgerLifecycleCloseout,
} from "../../packages/butler-agent/src/agent/tools/project-ledger/closeout.ts";
import { satisfiedCompletionObligationsForToolResult } from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import { projectLedgerRenderedViewEvidence } from "../../packages/butler-agent/src/integrations/project-ledger/client.ts";
import type { RuntimeMemoryAttributionPort } from
  "../../packages/butler-agent/src/operations/diagnostics/runtime-memory-attribution/index.ts";

test("Project Ledger closeout emits bounded phase start/end samples in causal order", () => {
  const phases: Array<{ phase: string; status: string; durationMs?: number }> = [];
  const attribution: RuntimeMemoryAttributionPort = {
    checkpoint() {},
    projectLedgerPhase(input) {
      phases.push(input);
    },
    terminal() {},
    close() {},
  };
  const closeout = runProjectLedgerLifecycleCloseout({
    executor: { butlerHome: "/tmp/butler", memoryAttribution: attribution },
    projectPath: "/tmp/butler/project-ledger/projects/demo",
    runTool: (_executor, args) => {
      if (args[0] === "render") {
        return { ok: true, data: { path: "safe-view.md", written: true } };
      }
      return { ok: true, data: { index: { path: "safe-index.json" }, issueCount: 0, issues: [] } };
    },
  });

  expect(closeout.ok).toBe(true);
  expect(phases.map(({ phase, status }) => `${phase}:${status}`)).toEqual([
    "index:start",
    "index:end",
    "render_dashboard:start",
    "render_dashboard:end",
    "render_handoff:start",
    "render_handoff:end",
    "render_roadmap:start",
    "render_roadmap:end",
    "check:start",
    "check:end",
  ]);
  expect(phases.filter(({ status }) => status === "end").every(({ durationMs }) =>
    typeof durationMs === "number" && durationMs >= 0)).toBe(true);
});

test("Project Ledger closeout emits a failure phase and stops subsequent stages", () => {
  const phases: string[] = [];
  const attribution: RuntimeMemoryAttributionPort = {
    checkpoint() {},
    projectLedgerPhase(input) {
      phases.push(`${input.phase}:${input.status}`);
    },
    terminal() {},
    close() {},
  };
  const closeout = runProjectLedgerLifecycleCloseout({
    executor: { butlerHome: "/tmp/butler", memoryAttribution: attribution },
    projectPath: "/tmp/butler/project-ledger/projects/demo",
    runTool: (_executor, args) => args[0] === "index"
      ? { ok: false, error: { code: "index_failed", message: "safe failure" } }
      : { ok: true },
  });

  expect(closeout.ok).toBe(false);
  expect(phases).toEqual(["index:start", "index:failure"]);
});

test("Project Ledger lifecycle closeout promotes closeout failure to recoverable validation failure", () => {
  const result = applyProjectLedgerLifecycleCloseout(
    { ok: true, data: { id: "T-CLOSEOUT" } },
    {
      ok: false,
      index_ok: true,
      rendered_views: [
        { view: "dashboard", ok: true, written: true },
        { view: "handoff", ok: false, written: false, error: { message: "render failed" } },
      ],
      check_ok: false,
      issue_count: 1,
      issues: [{ code: "stale_view", message: "handoff is stale" }],
      check_error: { message: "Project Ledger check failed." },
      failed_stages: ["render", "check"],
    },
  );

  expect(result).toMatchObject({
    ok: false,
    recoverable: true,
    observation_kind: "validation_failed",
    mutation_result: { ok: true, data: { id: "T-CLOSEOUT" } },
    error: {
      code: "project_ledger_closeout_failed",
      message: "Project Ledger lifecycle closeout failed after a successful mutation.",
      details: expect.arrayContaining([
        expect.objectContaining({ code: "render_failed", id: "handoff" }),
        expect.objectContaining({ code: "check_failed" }),
      ]),
      native_next: expect.arrayContaining([
        expect.objectContaining({ tool: "project_ledger_render", args: { view: "handoff", write: true } }),
        expect.objectContaining({ tool: "project_ledger_check", args: {} }),
      ]),
    },
  });
});

test("Project Ledger lifecycle closeout stops before rendering generated views when index fails", () => {
  const calls: string[] = [];
  const closeout = runProjectLedgerLifecycleCloseout({
    executor: { butlerHome: "/tmp/butler" },
    projectPath: "/tmp/butler/project-ledger/projects/demo",
    runTool: (_executor, args) => {
      calls.push(args.join(" "));
      return {
        ok: false,
        error: {
          code: "index_failed",
          message: "index source parse failed",
          native_next: [{ tool: "project_ledger_index", args: {}, reason: "repair source" }],
        },
      };
    },
  });

  expect(calls).toEqual(["index --project /tmp/butler/project-ledger/projects/demo"]);
  expect(closeout).toMatchObject({
    ok: false,
    index_ok: false,
    check_ok: false,
    check_skipped: true,
    issue_count: 0,
    failed_stages: ["index"],
    index_error: expect.objectContaining({
      code: "index_failed",
      message: "index source parse failed",
    }),
    rendered_views: [
      expect.objectContaining({ view: "dashboard", skipped: true, written: false }),
      expect.objectContaining({ view: "handoff", skipped: true, written: false }),
      expect.objectContaining({ view: "roadmap", skipped: true, written: false }),
    ],
  });
});

test("Project Ledger lifecycle closeout reuses the mutation index refresh", () => {
  const calls: string[] = [];
  const closeout = runProjectLedgerLifecycleCloseout({
    executor: { butlerHome: "/tmp/butler" },
    projectPath: "/tmp/butler/project-ledger/projects/demo",
    refreshedIndex: {
      ok: true,
      data: { index: { path: "project-ledger/projects/demo/index/project.json" } },
    },
    runTool: (_executor, args) => {
      calls.push(args.join(" "));
      if (args[0] === "render") {
        return {
          ok: true,
          data: {
            path: `project-ledger/projects/demo/views/${args[3]}.md`,
            written: true,
          },
        };
      }
      return { ok: true, data: { ok: true, issueCount: 0, issues: [] } };
    },
  });

  expect(calls.some((call) => call.startsWith("index "))).toBe(false);
  expect(calls).toHaveLength(4);
  expect(closeout).toMatchObject({
    ok: true,
    index_ok: true,
    check_ok: true,
    issue_count: 0,
  });
});

test("Project Ledger lifecycle closeout fails when render reports success without writing views", () => {
  const closeout = runProjectLedgerLifecycleCloseout({
    executor: { butlerHome: "/tmp/butler" },
    projectPath: "/tmp/butler/project-ledger/projects/demo",
    runTool: (_executor, args) => {
      if (args[0] === "index") {
        return { ok: true, data: { index: { path: "project-ledger/projects/demo/index/project.json" } } };
      }
      if (args[0] === "render") {
        return { ok: true, data: { path: `project-ledger/projects/demo/views/${args[3]}.md`, written: false } };
      }
      return { ok: true, data: { ok: true, issueCount: 0, issues: [] } };
    },
  });

  expect(closeout).toMatchObject({
    ok: false,
    index_ok: true,
    check_ok: true,
    failed_stages: ["render"],
    rendered_views: [
      expect.objectContaining({
        view: "dashboard",
        ok: false,
        written: false,
        error: expect.objectContaining({ code: "project_ledger_render_not_written" }),
      }),
      expect.objectContaining({ view: "handoff", ok: false, written: false }),
      expect.objectContaining({ view: "roadmap", ok: false, written: false }),
    ],
  });
});

test("Project Ledger render evidence satisfies durable artifact only after write and path are present", () => {
  const notWritten = projectLedgerRenderedViewEvidence({
    projectPath: "/tmp/butler/project-ledger/projects/demo",
    result: { ok: true, data: { path: "project-ledger/projects/demo/views/dashboard.md", written: false } },
    view: "dashboard",
    write: true,
  });
  const missingPath = projectLedgerRenderedViewEvidence({
    projectPath: "/tmp/butler/project-ledger/projects/demo",
    result: { ok: true, data: { written: true } },
    view: "dashboard",
    write: true,
  });
  const written = projectLedgerRenderedViewEvidence({
    projectPath: "/tmp/butler/project-ledger/projects/demo",
    result: { ok: true, data: { path: "project-ledger/projects/demo/views/dashboard.md", written: true } },
    view: "dashboard",
    write: true,
  });

  expect(notWritten).toEqual({});
  expect(missingPath).toEqual({});
  expect(satisfiedCompletionObligationsForToolResult("render_project_dashboard", notWritten)).toEqual([]);
  expect(satisfiedCompletionObligationsForToolResult("render_project_dashboard", missingPath)).toEqual([]);
  expect(satisfiedCompletionObligationsForToolResult("render_project_dashboard", written)).toContain("durable_artifact");
});
