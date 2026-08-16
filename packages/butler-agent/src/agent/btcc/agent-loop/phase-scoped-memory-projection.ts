import type {
  ContextDocumentRead,
  ContextDocumentReader,
  ContextProjectionClass,
} from "../../context/context-projection.ts";
import { PhaseScopedMemoryProjectionError } from
  "../../context/context-projection.ts";
import { createHash } from "node:crypto";
import type { TurnRecord } from "../turn/index.ts";
import type { GuidedTurnPhase } from "./guided-phase-policy.ts";
import {
  renderGuidedTurnRequestAttribution,
  type GuidedTurnRequestAttribution,
} from "./guided-turn-prompt.ts";

const MAX_MEMORY_PROJECTION_BYTES = 12 * 1024;
const CLASS_ORDER: readonly ContextProjectionClass[] = [
  "profile", "recent_feedback", "mandatory_hot_cache", "optional_hot_cache",
];
const PHASE_CLASSES: Record<GuidedTurnPhase, ReadonlySet<ContextProjectionClass>> = {
  direct: new Set(["profile", "recent_feedback"]),
  read_only: new Set(["profile", "recent_feedback", "mandatory_hot_cache"]),
  execution: new Set(CLASS_ORDER),
};

type PromptInput = Parameters<typeof renderGuidedTurnRequestAttribution>[3];

export function renderPhaseScopedGuidedTurnRequest(input: {
  enabled: boolean;
  phase: GuidedTurnPhase;
  turn: TurnRecord;
  stableInstructionPrefix: string;
  responseLanguage: string;
  promptInput: PromptInput;
  initialRequestBytes?: (
    request: { prompt: string; instructions: string }, butlerData?: string,
  ) => number;
  butlerData?: string;
}): GuidedTurnRequestAttribution {
  const exact = renderGuidedTurnRequestAttribution(
    input.turn,
    input.stableInstructionPrefix,
    input.responseLanguage,
    input.promptInput,
  );
  if (!input.enabled) return exact;

  const refsByClass = contextRefsByClass(input.turn);
  const allowed = PHASE_CLASSES[input.phase];
  const excluded = CLASS_ORDER.some((projectionClass) =>
    !allowed.has(projectionClass) && refsByClass[projectionClass].length > 0,
  );
  if (!excluded) return exact;
  if (!input.initialRequestBytes ||
      typeof (input.promptInput.contextDocuments as Partial<ContextDocumentReader>).read !==
        "function") {
    throw new PhaseScopedMemoryProjectionError(
      "phase_scoped_memory_dependency_missing",
    );
  }

  const documents = readProjectedDocuments({
    source: input.promptInput.contextDocuments as ContextDocumentReader,
    refsByClass,
    allowed,
  });
  const emptyCandidate = renderGuidedTurnRequestAttribution(
    input.turn,
    input.stableInstructionPrefix,
    input.responseLanguage,
    {
      ...input.promptInput,
      contextDocuments: createProjectedDocumentReader(documents, 0),
    },
  );
  const fixedMemoryBytes = renderedMemoryProjectionBytes(emptyCandidate);
  if (fixedMemoryBytes > MAX_MEMORY_PROJECTION_BYTES) {
    throw new PhaseScopedMemoryProjectionError(
      "phase_scoped_memory_projection_too_large",
    );
  }
  const projectedDocuments = createProjectedDocumentReader(
    documents,
    MAX_MEMORY_PROJECTION_BYTES - fixedMemoryBytes,
  );
  const candidate = renderGuidedTurnRequestAttribution(
    input.turn,
    input.stableInstructionPrefix,
    input.responseLanguage,
    { ...input.promptInput, contextDocuments: projectedDocuments },
  );
  if (renderedMemoryProjectionBytes(candidate) > MAX_MEMORY_PROJECTION_BYTES) {
    throw new PhaseScopedMemoryProjectionError(
      "phase_scoped_memory_projection_too_large",
    );
  }
  try {
    const serialize = input.initialRequestBytes;
    return serializedBytes(serialize, candidate, input.butlerData) <
        serializedBytes(serialize, exact, input.butlerData)
      ? candidate
      : exact;
  } catch (error) {
    if (error instanceof PhaseScopedMemoryProjectionError) throw error;
    throw new PhaseScopedMemoryProjectionError(
      "phase_scoped_memory_serializer_failed",
      { cause: error },
    );
  }
}

function readProjectedDocuments(input: {
  source: ContextDocumentReader;
  refsByClass: Record<ContextProjectionClass, readonly string[]>;
  allowed: ReadonlySet<ContextProjectionClass>;
}): ContextDocumentRead[] {
  const refs = CLASS_ORDER.flatMap((projectionClass) =>
    input.refsByClass[projectionClass].map((contextRef) => ({
      contextRef, expectedClass: projectionClass,
    })),
  );
  const validated = refs.map(({ contextRef, expectedClass }) => {
    try {
      const document = input.source.read(contextRef);
      if (document.contextRef !== contextRef ||
          document.projectionClass !== expectedClass ||
          !isVerifiedDocumentRead(document)) {
        throw new Error("context_document_projection_class_mismatch");
      }
      return document;
    } catch (error) {
      throw new PhaseScopedMemoryProjectionError(
        "phase_scoped_memory_document_invalid",
        { cause: error },
      );
    }
  });
  return validated.filter((document) =>
    input.allowed.has(document.projectionClass),
  );
}

function createProjectedDocumentReader(
  documents: readonly ContextDocumentRead[],
  contentByteBudget: number,
): ContextDocumentReader {
  const rendered = renderDocumentsWithinContentBudget(documents, contentByteBudget);
  const byRef = new Map(rendered.map((value, index) => [documents[index]!.contextRef, value]));
  return {
    read(contextRef) {
      const document = documents.find((candidate) => candidate.contextRef === contextRef);
      if (!document) {
        throw new PhaseScopedMemoryProjectionError(
          "phase_scoped_memory_document_invalid",
        );
      }
      return document;
    },
    resolve(contextRef) {
      return byRef.get(contextRef) ?? "";
    },
  };
}

function isVerifiedDocumentRead(document: ContextDocumentRead): boolean {
  return /^[a-f0-9]{64}$/u.test(document.contextRef) &&
    /^[a-f0-9]{64}$/u.test(document.contentSha256) &&
    createHash("sha256").update(document.content).digest("hex") ===
      document.contentSha256 &&
    CLASS_ORDER.includes(document.projectionClass) &&
    ["user", "session", "project"].includes(document.scopeKind) &&
    isBoundedPublicIdentity(document.sourceId) &&
    isBoundedPublicIdentity(document.sourceRevision);
}

function isBoundedPublicIdentity(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/u.test(value);
}

function renderDocumentsWithinContentBudget(
  documents: readonly ContextDocumentRead[],
  contentByteBudget: number,
): string[] {
  const empty = documents.map((document) => renderDocument(document, ""));
  let remaining = contentByteBudget;
  return documents.map((document, index) => {
    const content = truncateJsonContent(document.content, remaining);
    const rendered = renderDocument(document, content);
    remaining -= Buffer.byteLength(rendered, "utf8") -
      Buffer.byteLength(empty[index]!, "utf8");
    return rendered;
  });
}

function renderDocument(document: ContextDocumentRead, content: string): string {
  return JSON.stringify({
    sourceId: document.sourceId,
    projectionClass: document.projectionClass,
    scopeKind: document.scopeKind,
    sourceRevision: document.sourceRevision,
    content,
  });
}

function truncateJsonContent(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const encoded = JSON.stringify(character);
    const next = Buffer.byteLength(encoded.slice(1, -1), "utf8");
    if (bytes + next > maxBytes) break;
    result += character;
    bytes += next;
  }
  return result;
}

function contextRefsByClass(
  turn: TurnRecord,
): Record<ContextProjectionClass, readonly string[]> {
  return {
    profile: turn.context.profileRefs,
    recent_feedback: turn.context.recentFeedbackRefs,
    mandatory_hot_cache: turn.context.mandatoryHotCacheRefs,
    optional_hot_cache: turn.context.optionalHotCacheRefs,
  };
}

function renderedMemoryProjectionBytes(
  request: GuidedTurnRequestAttribution,
): number {
  return [
    ...request.requestSegmentSources.input,
    ...request.requestSegmentSources.instructions,
  ].filter((source) => source.kind === "memory_recall_context")
    .reduce((total, source) => total + Buffer.byteLength(source.text, "utf8"), 0);
}

function serializedBytes(
  serialize: NonNullable<Parameters<typeof renderPhaseScopedGuidedTurnRequest>[0]["initialRequestBytes"]>,
  request: GuidedTurnRequestAttribution,
  butlerData?: string,
): number {
  const bytes = serialize({
    prompt: request.prompt,
    instructions: request.instructions,
  }, butlerData);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new PhaseScopedMemoryProjectionError(
      "phase_scoped_memory_serializer_failed",
    );
  }
  return bytes;
}
