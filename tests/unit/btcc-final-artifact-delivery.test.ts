import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectGuidedFinalArtifacts } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-final-artifacts.ts";
import { collectGuidedChangedFiles } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-changed-files.ts";
import { normalizeTerminalReportContent } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/terminal-results.ts";
import { projectChildTerminalReport, projectTurnOutcome } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/project-turn-outcome.ts";
import { artifactFilesFromOutbound } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/transport/outbound-artifact-files.ts";
import { AppMessageFileStore } from
  "../../packages/butler-agent/src/gateways/app/domain/message-files/message-file-store.ts";
import { migrateAppStoreSchema } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/core/schema.ts";

test("a child report reaches the parent attachment store without another tool call", () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-inherited-artifact-"));
  const db = new Database(":memory:");
  try {
    migrateAppStoreSchema(db);
    const messageFiles = new AppMessageFileStore(db, root, () => {});
    mkdirSync(join(root, "artifacts"));
    writeFileSync(join(root, "artifacts", "report.md"), "# Completed report\n");
    const report = {
      id: "artifact-report", kind: "report" as const, title: "report.md",
      safePathLabel: "artifacts/report.md", mimeType: "text/plain",
    };
    const artifacts = collectGuidedFinalArtifacts([], [report, report]);
    expect(artifacts).toEqual([report]);
    const files = messageFiles.createResponderFiles("general", artifactFilesFromOutbound({
      butlerData: root, butlerHome: root, chatId: "general", artifacts, messageFiles,
      getChatRow: () => null, getProjectRow: () => null,
    }));
    messageFiles.attachToMessage("general", "answer", files);
    const refs = messageFiles.refsForMessage("answer");
    expect(refs).toHaveLength(1);
    expect(refs[0]?.safe_name).toBe("report.md");
    expect(messageFiles.download(refs[0]!.file_id).bytes.toString()).toBe("# Completed report\n");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("completed guided tool results become bounded safe final artifacts", () => {
  const artifacts = collectGuidedFinalArtifacts([
    {
      callId: "call-1",
      toolName: "run_command",
      rawArguments: "{}",
      arguments: {},
      status: "completed",
      result: {
        ok: true,
        artifacts: [
          {
            path: "artifacts/generated/capture/page.png",
            artifact_kind: "chart_file",
            size_bytes: 128,
            modified_at: "2026-08-09T00:00:00.000Z",
          },
          {
            path: "/Users/private/leak.txt",
            artifact_kind: "file",
            size_bytes: 10,
            modified_at: "2026-08-09T00:00:00.000Z",
          },
          {
            path: "artifacts/generated/../private.txt",
            artifact_kind: "file",
            size_bytes: 10,
            modified_at: "2026-08-09T00:00:00.000Z",
          },
        ],
      },
    },
    {
      callId: "call-failed",
      toolName: "run_command",
      rawArguments: "{}",
      arguments: {},
      status: "failed",
      result: {
        artifacts: [{
          path: "artifacts/generated/failed.txt",
          artifact_kind: "file",
          size_bytes: 4,
        }],
      },
    },
  ]);

  expect(artifacts).toEqual([{
    id: expect.stringMatching(/^artifact-/u),
    kind: "chart_file",
    title: "page.png",
    safePathLabel: "artifacts/generated/capture/page.png",
    mimeType: "image/png",
    sizeBytes: 128,
    createdAt: "2026-08-09T00:00:00.000Z",
  }]);
});

test("accepted parent result carries typed changed files separately from artifacts", () => {
  expect(collectGuidedFinalArtifacts([])).toEqual([]);
  expect(collectGuidedChangedFiles([], [{
    path: "research/memory-brain-structure-ko.md",
    additions: 1,
    deletions: 0,
    lines: [{ type: "added", new_line: 1, content: "# Result" }],
  }])).toEqual([{
    path: "research/memory-brain-structure-ko.md",
    additions: 1,
    deletions: 0,
    lines: [{ type: "added", new_line: 1, content: "# Result" }],
  }]);
});

test("BTCC gateway outcome projection preserves typed final artifacts", () => {
  const result = projectTurnOutcome({
    kind: "delivered",
    turnId: "turn-artifact",
    messageId: "message-artifact",
    content: "캡처 결과입니다.",
    artifacts: [{
      id: "artifact-page",
      kind: "chart_file",
      title: "page.png",
      safePathLabel: "artifacts/generated/capture/page.png",
      mimeType: "image/png",
      sizeBytes: 128,
    }],
  });

  expect(result).toEqual({
    text: "캡처 결과입니다.",
    changedFiles: [],
    artifacts: [{
      id: "artifact-page",
      kind: "chart_file",
      title: "page.png",
      safePathLabel: "artifacts/generated/capture/page.png",
      mimeType: "image/png",
      sizeBytes: 128,
    }],
  });
});

test("structured child reports become a natural summary and changed artifacts", () => {
  const report = projectChildTerminalReport(projectTurnOutcome({
    kind: "delivered",
    turnId: "turn-report",
    messageId: "message-report",
    content: JSON.stringify({
      status: "success",
      version: 1,
      summary: "호환성 조사와 보고서 작성을 완료했습니다.",
      changed_artifacts: ["research/qwen-turboquant-vllm.md"],
    }),
    artifacts: [{
      id: "artifact-report",
      kind: "report",
      title: "qwen-turboquant-vllm.md",
      safePathLabel: "research/qwen-turboquant-vllm.md",
    }],
  }));

  expect(report).toEqual({
    summary: "호환성 조사와 보고서 작성을 완료했습니다.",
    changedArtifacts: ["research/qwen-turboquant-vllm.md"],
    changedFiles: [],
  });
});

test("natural child reports retain material review findings for the parent role", () => {
  const content = [
    "독립 검토 결과",
    "",
    "판정: 완료 불가",
    "- 직접 vision 호출의 telemetry가 누락되었습니다.",
    "- tool query 원문이 로그에 남습니다.",
  ].join("\n");
  const report = projectChildTerminalReport(projectTurnOutcome({
    kind: "delivered",
    turnId: "turn-natural-report",
    messageId: "message-natural-report",
    content,
  }));

  expect(report).toEqual({
    summary: content,
    changedArtifacts: [],
    changedFiles: [],
  });
  expect(normalizeTerminalReportContent(`  ${content.replaceAll("-", "-  ")}  `))
    .toContain("판정: 완료 불가\n- 직접 vision 호출의 telemetry가 누락되었습니다.");
  expect(normalizeTerminalReportContent(`${"검토 본문 ".repeat(1_000)}\nTAIL_FINDING`))
    .toEndWith("TAIL_FINDING");
});

test("App artifact resolution rejects symlink escapes, missing files, and empty files", () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-final-artifact-safety-"));
  const butlerData = join(root, "data");
  const artifactRoot = join(butlerData, "artifacts", "generated");
  const workspace = join(root, "workspace");
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "private");
  symlinkSync(outside, join(artifactRoot, "leak.txt"));
  writeFileSync(join(artifactRoot, "empty.txt"), "");
  try {
    const files = artifactFilesFromOutbound({
      butlerData,
      butlerHome: workspace,
      messageFiles: { refsForMessage: () => [] } as never,
      getChatRow: () => null,
      getProjectRow: () => null,
      chatId: "chat",
      artifacts: [
        {
          id: "leak",
          kind: "file",
          title: "leak.txt",
          safePathLabel: "artifacts/generated/leak.txt",
        },
        {
          id: "missing",
          kind: "file",
          title: "missing.txt",
          safePathLabel: "artifacts/generated/missing.txt",
        },
        {
          id: "empty",
          kind: "file",
          title: "empty.txt",
          safePathLabel: "artifacts/generated/empty.txt",
        },
      ],
    });
    expect(files).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
