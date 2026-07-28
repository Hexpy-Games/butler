import { describe, expect, test } from "bun:test";
import { projectOperationContext } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/model/project-operation-context.ts";
import { operationContextCompactionCandidates } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/model/project-operation-context.ts";
import { promptOperationContext } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/model/project-operation-context.ts";
import { fitOperationContext } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/model/fit-operation-context.ts";
import { describeOperationSource } from
  "../../packages/butler-agent/src/agent/btcc/operation-result/index.ts";
import type {
  PhaseEnvelope,
} from "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import type { OperationResultProjection } from
  "../../packages/butler-agent/src/agent/btcc/operation-result/index.ts";

describe("BTCC operation context projection", () => {
  test("retains source results and exact selected views across later batches", () => {
    const source = result("source-read", "read_file");
    const previousRead = result("first-result-read", "read_operation_result", source, {
      selector: "lines",
      startLine: 1,
      limit: 20,
    });
    const latestRead = result("second-result-read", "read_operation_result", source, {
      selector: "bytes",
      start: 100,
      length: 200,
    });
    const envelope = {
      operationResults: [source, previousRead, latestRead],
      latestOperationResultCount: 1,
    } as PhaseEnvelope;

    expect(projectOperationContext(envelope)).toEqual({
      phaseContinuity: null,
      inlineOperationResults: [source],
      selectedOperationResultViews: [previousRead, latestRead],
      priorOperationResultIndex: [],
    });
  });

  test("keeps one exact selected view per source and selector across later batches", () => {
    const source = result("source-read", "read_file");
    const firstRead = result("first-result-read", "read_operation_result", source, {
      selector: "lines",
      startLine: 1,
      limit: 20,
    });
    const duplicateRead = result("duplicate-result-read", "read_operation_result", source, {
      selector: "lines",
      startLine: 1,
      limit: 20,
    });
    const latestSource = result("latest-source", "grep_files");

    const projected = projectOperationContext({
      operationResults: [source, firstRead, duplicateRead, latestSource],
      latestOperationResultCount: 1,
    } as PhaseEnvelope);

    expect(projected.selectedOperationResultViews).toEqual([duplicateRead]);
    expect(projected.inlineOperationResults).toEqual([source, latestSource]);
  });

  test("compacts oldest source payloads before selected views and retains indexes", () => {
    const source = result("source-read", "read_file");
    const selected = result("selected-read", "read_operation_result", source, {
      selector: "lines",
      startLine: 1,
      limit: 20,
    });
    const latest = result("latest-source", "grep_files");
    const candidates = operationContextCompactionCandidates(projectOperationContext({
      operationResults: [source, selected, latest],
      latestOperationResultCount: 1,
    } as PhaseEnvelope));

    expect(candidates.map((candidate) => ({
      inline: candidate.inlineOperationResults.length,
      selected: candidate.selectedOperationResultViews.length,
    }))).toEqual([
      { inline: 2, selected: 1 },
      { inline: 1, selected: 1 },
      { inline: 0, selected: 1 },
      { inline: 0, selected: 0 },
    ]);
    expect(candidates.at(-1)!.priorOperationResultIndex.map((entry) => entry.resultRef))
      .toEqual([source.resultRef, latest.resultRef]);
  });

  test("uses measured model input capacity instead of a fixed character ceiling", () => {
    const source = result("source-read", "read_file");
    const selected = {
      ...result("selected-read", "read_operation_result", source, {
        selector: "lines",
        startLine: 1,
        limit: 20,
      }),
      view: {
        selector: { kind: "lines" as const, startLine: 1, limit: 20 },
        content: "selected-contract ".repeat(20_000),
        byteStart: 0,
        byteEnd: 360_000,
        complete: true,
      },
    };
    const latest = result("latest-source", "grep_files");
    const projected = projectOperationContext({
      operationResults: [source, selected, latest],
      latestOperationResultCount: 1,
    } as PhaseEnvelope);

    const fitted = fitOperationContext({
      projected,
      modelSelection: {
        provider: "openai",
        model: "gpt-5.6-sol",
        reasoningEffort: "low",
        controls: {},
        controlsHash: "controls",
        contextWindowTokens: 130_000,
      },
      renderPrompt: (context) => JSON.stringify(context),
      fixedRequestShape: {},
    });

    expect(fitted.inlineOperationResults).toEqual([]);
    expect(fitted.selectedOperationResultViews).toEqual([]);
    expect(fitted.priorOperationResultIndex.map((entry) => entry.resultRef))
      .toContainEqual(source.resultRef);
  });

  test("labels full inline results as complete instead of previews", () => {
    const complete = {
      ...result("complete-source", "read_file"),
      preview: "entire requested file",
      byteLength: 21,
      omittedBytes: 0,
    };
    const partial = {
      ...result("partial-source", "read_file"),
      preview: "first bytes",
      byteLength: 100,
      omittedBytes: 89,
    };

    const context = promptOperationContext(projectOperationContext({
      operationResults: [complete, partial],
      latestOperationResultCount: 1,
    } as PhaseEnvelope));

    expect(context.inlineOperationResults.map((item) => item.inlinePayload)).toEqual([
      { kind: "complete", content: "entire requested file" },
      { kind: "partial", content: "first bytes", omittedBytes: 89 },
    ]);
    expect(context.inlineOperationResults[0]).not.toHaveProperty("preview");
  });

  test("describes mutation targets without copying their payload", () => {
    const source = describeOperationSource({
      requestId: "write-source",
      publicTitle: "Test operation",
      kind: "workspace_artifact_action",
      capabilityRef: "write_file",
      workspaceRef: ref("workspace"),
      relativeTarget: "src/source.ts",
      input: { path: "src/source.ts", content: "large mutation payload" },
    });

    expect(source).toEqual({
      kind: "workspace_artifact_action",
      capabilityRef: "write_file",
      workspaceRef: ref("workspace"),
      relativeTarget: "src/source.ts",
    });
    expect(JSON.stringify(source)).not.toContain("large mutation payload");
  });

  test("keeps command completion in the compact durable index", () => {
    const command = {
      ...result("validation", "run_command"),
      executionSummary: {
        kind: "command_execution" as const,
        exitCode: 0,
        timedOut: false,
        signal: null,
      },
    };
    const latest = result("latest-source", "grep_files");

    const projected = projectOperationContext({
      operationResults: [command, latest],
      latestOperationResultCount: 1,
    } as PhaseEnvelope);
    const compacted = operationContextCompactionCandidates(projected)[1]!;

    expect(compacted.priorOperationResultIndex[0]?.executionSummary)
      .toEqual(command.executionSummary);
  });
});

function result(
  requestId: string,
  capabilityRef: string,
  source?: OperationResultProjection,
  input: Record<string, unknown> = {},
): OperationResultProjection {
  const resultRef = source?.resultRef ?? ref(`result-${requestId}`);
  return {
    resultRef,
    requestRef: source?.requestRef ?? ref(`request-${requestId}`),
    requestId,
    request: {
      requestId,
      publicTitle: "Read operation context",
      kind: "observe",
      capabilityRef,
      scopeRef: "workspace:/repo",
      input,
    },
    capabilityRef,
    outcome: "observed",
    completeness: "complete",
    byteLength: 1_000,
    observationRef: ref("observation-source"),
    preview: capabilityRef === "read_file" ? "source preview" : "",
    omittedBytes: 0,
    readScopeRef: `result:${resultRef.id}:${resultRef.sha256}`,
    ...(capabilityRef === "read_operation_result"
      ? {
          view: {
            selector: input as never,
            content: requestId,
            byteStart: 0,
            byteEnd: requestId.length,
            complete: true,
          },
        }
      : {}),
  };
}

function ref(id: string) {
  return { id, sha256: `${id}-sha` };
}
