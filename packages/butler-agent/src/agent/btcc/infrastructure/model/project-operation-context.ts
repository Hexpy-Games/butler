import type { PhaseEnvelope } from "../../core/index.ts";
import type {
  OperationSourceDescriptor,
  OperationResultIndexEntry,
  OperationResultProjection,
  ResultRef,
} from "../../operation-result/index.ts";
import {
  indexOperationResult,
  isResultReadRequest,
  stableJson,
} from "../../operation-result/index.ts";

export type ProjectedOperationContext = {
  phaseContinuity: PhaseEnvelope["phaseContinuity"] | null;
  inlineOperationResults: OperationResultProjection[];
  selectedOperationResultViews: OperationResultProjection[];
  priorOperationResultIndex: OperationResultIndexEntry[];
};

export type PromptOperationContext = {
  phaseContinuity: PhaseEnvelope["phaseContinuity"] | null;
  inlineOperationResults: PromptInlineOperationResult[];
  selectedOperationResultViews: PromptSelectedOperationResultView[];
  priorOperationResultIndex: OperationResultIndexEntry[];
};

type PromptInlineOperationResult = OperationResultMetadata & {
  source: OperationSourceDescriptor;
  inlinePayload:
    | { kind: "complete"; content: string }
    | { kind: "partial"; content: string; omittedBytes: number };
};

type PromptSelectedOperationResultView = OperationResultMetadata & {
  source: OperationSourceDescriptor;
  exactView: NonNullable<OperationResultProjection["view"]>;
};

type OperationResultMetadata = Omit<
  OperationResultProjection,
  "request" | "preview" | "content" | "omittedBytes" | "view"
>;

export function projectOperationContext(envelope: PhaseEnvelope): ProjectedOperationContext {
  const latestCount = envelope.latestOperationResultCount ?? 0;
  const latestStart = envelope.operationResults.length - latestCount;
  if (latestStart < 0) {
    throw new Error("Latest operation batch exceeds the persisted result sequence");
  }
  return {
    phaseContinuity: envelope.phaseContinuity ?? null,
    inlineOperationResults: envelope.operationResults.filter(
      (result) => !isResultReadRequest(result.request),
    ),
    selectedOperationResultViews: selectedViews(envelope.operationResults),
    priorOperationResultIndex: [],
  };
}

export function promptOperationContext(
  projected: ProjectedOperationContext,
): PromptOperationContext {
  return {
    phaseContinuity: projected.phaseContinuity,
    inlineOperationResults: projected.inlineOperationResults.map(inlineResult),
    selectedOperationResultViews: projected.selectedOperationResultViews.map(selectedView),
    priorOperationResultIndex: projected.priorOperationResultIndex,
  };
}

export function operationContextCompactionCandidates(
  projected: ProjectedOperationContext,
): ProjectedOperationContext[] {
  const candidates = [projected];
  let inline = [...projected.inlineOperationResults];
  let selected = [...projected.selectedOperationResultViews];
  let compacted = [...projected.priorOperationResultIndex];

  while (inline.length > 0) {
    compacted = indexPriorResults([...compacted, inline[0]!]);
    inline = inline.slice(1);
    candidates.push(withPayloadSet(projected, inline, selected, compacted));
  }
  while (selected.length > 0) {
    compacted = indexPriorResults([...compacted, selected[0]!]);
    selected = selected.slice(1);
    candidates.push(withPayloadSet(projected, inline, selected, compacted));
  }
  return candidates;
}

function selectedViews(
  results: OperationResultProjection[],
): OperationResultProjection[] {
  const byView = new Map<string, OperationResultProjection>();
  for (const result of results) {
    if (!hasSelectedView(result)) continue;
    const key = viewKey(result);
    byView.set(key, result);
  }
  return [...byView.values()];
}

function hasSelectedView(result: OperationResultProjection): boolean {
  return isResultReadRequest(result.request) && Boolean(result.view);
}

function viewKey(result: OperationResultProjection): string {
  return `${resultIdentity(result.resultRef)}\0${stableJson(result.request.input)}`;
}

function withPayloadSet(
  projected: ProjectedOperationContext,
  inline: OperationResultProjection[],
  selected: OperationResultProjection[],
  compacted: OperationResultIndexEntry[],
): ProjectedOperationContext {
  return {
    ...projected,
    inlineOperationResults: inline,
    selectedOperationResultViews: selected,
    priorOperationResultIndex: compacted,
  };
}

function inlineResult(result: OperationResultProjection): PromptInlineOperationResult {
  const metadata = operationResultMetadata(result);
  const content = result.content ?? result.preview;
  return {
    ...metadata,
    source: indexOperationResult(result).source,
    inlinePayload: result.omittedBytes === 0
      ? { kind: "complete", content }
      : { kind: "partial", content, omittedBytes: result.omittedBytes },
  };
}

function selectedView(
  result: OperationResultProjection,
): PromptSelectedOperationResultView {
  if (!result.view) throw new Error("Selected operation result view is missing");
  return {
    ...operationResultMetadata(result),
    source: indexOperationResult(result).source,
    exactView: result.view,
  };
}

function operationResultMetadata(
  result: OperationResultProjection,
): OperationResultMetadata {
  const {
    request: _request,
    preview: _preview,
    content: _content,
    omittedBytes: _omittedBytes,
    view: _view,
    ...metadata
  } = result;
  return metadata;
}

function indexPriorResults(
  results: Array<OperationResultProjection | OperationResultIndexEntry>,
) {
  const byResult = new Map<string, OperationResultIndexEntry>();
  for (const result of results) {
    if (isIndexEntry(result)) {
      const identity = resultIdentity(result.resultRef);
      if (!byResult.has(identity)) byResult.set(identity, result);
      continue;
    }
    const identity = resultIdentity(result.resultRef);
    if (!byResult.has(identity)) byResult.set(identity, indexOperationResult(result));
  }
  return [...byResult.values()];
}

function isIndexEntry(
  result: OperationResultProjection | OperationResultIndexEntry,
): result is OperationResultIndexEntry {
  return "source" in result;
}

function resultIdentity(ref: ResultRef): string {
  return `${ref.id}\0${ref.sha256}`;
}
