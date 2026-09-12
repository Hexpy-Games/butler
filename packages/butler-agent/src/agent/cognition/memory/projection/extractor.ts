import { createHash } from "node:crypto";
import { runPromptTextWithUsage } from "../../../../integrations/providers/runtime.ts";
import type { ProviderStreamProjectionHandler } from "../../../../integrations/providers/runtime-contracts.ts";
import { validateJsonObjectSchema } from "../../../tools/schema-validation.ts";
import type { ExtractInput, ExtractOutput, MemoryExecutionContext, QuoteRef } from "./contracts.ts";
import { graphemeCount } from "./unicode.ts";
import { MEANING_INSTRUCTIONS, MEANING_SCHEMA, meaningPrompt, sourcePassages, validateMeaning, meaningToOutput } from "./meaning.ts";
import { BINDING_INSTRUCTIONS, BINDING_SCHEMA, MemoryBindingValidationError, prepareBindingBatches, applyBinding, bindingRepairSchema, type CandidateLoader, type BindingWarning } from "./binding.ts";

const MAX_STAGE_REPAIRS = 2;

function boundedEvidenceSchema(schema: Record<string, unknown>, passageCount: number): Record<string, unknown> {
  const bounded = structuredClone(schema);
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    const properties = node.properties as Record<string, unknown> | undefined;
    if (properties?.evidence) (properties.evidence as Record<string, unknown>).items = { type: "integer", minimum: 0, maximum: passageCount - 1 };
    for (const child of Object.values(node)) visit(child);
  };
  visit(bounded);
  return bounded;
}

export const MAX_MEMORY_EXTRACTION_TIMEOUT_MS = 600_000;
const DEFAULT_MEMORY_EXTRACTION_TIMEOUT_MS = 180_000;

export function memoryExtractionTimeoutMs(model: string, targetKind: MemoryExecutionContext["target"]["kind"]): number {
  return targetKind === "rebuild" && (model === "zai/glm-5.3" || model === "zai-api/glm-5.3")
    ? MAX_MEMORY_EXTRACTION_TIMEOUT_MS : DEFAULT_MEMORY_EXTRACTION_TIMEOUT_MS;
}

const IDENTITY_REUSE_GUIDANCE = "For resolution.kind=reuse, locate the exact candidate whose ref equals node_ref. resolution.evidence must include a current-source quote and a historical quote whose unit_ref occurs in that selected candidate.evidence. A quote from another candidate or context is not a substitute even if it names the same entity. candidate.claim subject/object refs describe stored structure and do not authorize reuse of nodes absent from candidates.";
const OUTPUT_ENDPOINT_DESCRIPTION = "A local_ref declared in this same output's nodes or claims; never a stored candidate.ref.";
const RELATION_CLAIM_GUIDANCE = "A relation's claim_ref must refer to an assertion claim in this output; from_ref and to_ref must equal that claim's subject_ref and object_ref. Keep questions and proposals as claims with their original speech_act and emit no relation for them; do not relabel them as assertions to permit a relation.";
const TYPED_CORRECTION_GUIDANCE = "For correction of an existing typed claim, preserve its subject, claim type, predicate, and condition. Express negation with polarity while keeping the predicate: not liking is likes plus negative, not dislikes plus negative. The replacement assertion must include the same typed relation, including a negative assertion. An explicit object replacement may supersede the old claim on that same predicate. Ordinary claims may omit relations; do not invent a predicate for an existing claim without one. Use candidate.claim when supplied; older fixed inputs may omit it, so use only their supplied candidate evidence. Never translate source statements or quotes to satisfy this rule.";

export type ExtractionStageResult = { request_hash: string; raw: string; evidence: StageEvidence };
type StageEvidence = {
  reported_model: string;
  usage: { prompt_tokens: number | null; cached_tokens: number; output_tokens: number; total_tokens: number | null } | null;
  duration_ms: number;
  request_wire: RequestWireEvidence;
};
type RequestWireEvidence = { profile: string; input_json_sha256: string; input_json_utf8_bytes: number; instructions_sha256: string; output_schema_sha256: string };
export type ExtractionStages = {
  load: (key: string) => Promise<ExtractionStageResult | null>;
  save: (key: string, result: ExtractionStageResult) => Promise<void>;
};

export async function runStructuredMemoryExtractor(input: {
  butlerData: string;
  extractInput: ExtractInput;
  model: string;
  reasoningEffort: string;
  signal: AbortSignal;
  loadCandidates: CandidateLoader;
  stages: ExtractionStages;
  onProviderStreamEvent?: ProviderStreamProjectionHandler;
  onRequestPrepared?: (evidence: RequestWireEvidence) => void;
  onProviderInvocationIntent?: () => Promise<void>;
  onProviderAdapterEntry?: () => void;
}): Promise<{ output: ExtractOutput; evidence: StageEvidence & { warnings: BindingWarning[]; stages: Array<StageEvidence & { stage: string; reused: boolean }> } }> {
  const started = Date.now();
  const stages: Array<StageEvidence & { stage: string; reused: boolean }> = [];
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const call = async <T>(stage: string, promptValue: unknown, instructions: string, schema: Record<string, unknown>, validate: (value: unknown) => T, repairSchema?: Record<string, unknown>): Promise<T> => {
    let rejection: string | null = null;
    let rejectionCode: string | null = null;
    for (let repair = 0; repair <= MAX_STAGE_REPAIRS; repair++) {
      const prompt = JSON.stringify(repair === 0 ? promptValue : { input: promptValue,
        correction: { error: rejection, instruction: "Return a corrected complete response. Use only the provided reference IDs and evidence. Do not invent IDs." } });
      const responseSchema = repair === 0 ? schema : repairSchema ?? (stage === "meaning" ? boundedEvidenceSchema(schema, passages.length) : schema);
      const request_wire = { profile: `memory-${stage}.v4`, input_json_sha256: hash(prompt), input_json_utf8_bytes: Buffer.byteLength(prompt),
        instructions_sha256: hash(instructions), output_schema_sha256: hash(JSON.stringify(responseSchema)) };
      // The original key is unchanged. Repair responses are append-only and separately addressable.
      const request_hash = hash(JSON.stringify([input.extractInput.revision, input.model, input.reasoningEffort, request_wire, stage === "meaning" ? null : input.extractInput.candidates]));
      const key = `${stage}:${request_hash}${repair ? `:repair:${repair}` : ""}`;
      const saved = await input.stages.load(key);
      let result: ExtractionStageResult;
      if (saved) {
        if (saved.request_hash !== request_hash) throw new Error("memory_extract_stage_changed");
        result = saved;
      } else {
        input.onRequestPrepared?.(request_wire);
        const stageStarted = Date.now();
        const response = await runPromptTextWithUsage({ prompt, instructions, model: input.model,
          reasoningEffort: input.reasoningEffort as "low" | "medium" | "high" | "xhigh" | "max",
          cacheScope: `memory-extract:${input.extractInput.revision}:${stage}`, butlerData: input.butlerData,
          signal: input.signal, onProviderStreamEvent: input.onProviderStreamEvent, providerRetryAttempts: 0,
          responseFormat: { type: "json_schema", name: `memory_${stage.replace(/[^a-z]/g, "_")}_v4`, strict: true, schema: responseSchema },
        }, { onInvocationIntent: input.onProviderInvocationIntent, onAdapterEntry: input.onProviderAdapterEntry });
        result = { request_hash, raw: response.text, evidence: { reported_model: response.model,
          usage: response.usage ? { prompt_tokens: response.usage.promptTokens, cached_tokens: response.usage.cachedTokens,
            output_tokens: response.usage.outputTokens, total_tokens: response.usage.totalTokens } : null,
          duration_ms: Date.now() - stageStarted, request_wire } };
        await input.stages.save(key, result);
      }
      const evidence = { ...result.evidence, stage, reused: Boolean(saved), repair };
      stages.push(evidence);
      try {
        let value: unknown;
        try { value = JSON.parse(result.raw); }
        catch (cause) { throw new Error("memory_extract_invalid_json", { cause }); }
        return validate(value);
      } catch (cause) {
        if (!(cause instanceof Error) || !cause.message.startsWith("memory_extract_invalid_")) throw cause;
        rejectionCode = cause.message;
        rejection = cause instanceof MemoryBindingValidationError ? cause.repairFeedback : rejectionCode;
        if (repair === MAX_STAGE_REPAIRS)
          throw new MemoryExtractAttemptError(rejectionCode, result.raw, { ...evidence, repair_exhausted: true }, cause, true);
      }
    }
    throw new Error("memory_extract_stage_changed");
  };
  const passages = sourcePassages(input.extractInput);
  const instructions = input.extractInput.context_units.some((unit) => unit.source_span)
    ? `${MEANING_INSTRUCTIONS} Before/after belongs to the same source and explains the current text; do not extract surrounding-only facts.`
    : MEANING_INSTRUCTIONS;
  const meaning = await call("meaning", meaningPrompt(input.extractInput, passages), instructions, MEANING_SCHEMA,
    (value) => validateMeaning(value, passages));
  if (meaning.status !== "processed") throw new MemoryExtractDispositionError(meaning.status, meaning, stages.at(-1)!);
  const output = meaningToOutput(input.extractInput, meaning, passages);
  const binding = await prepareBindingBatches(meaning, passages, input.loadCandidates);
  input.extractInput.candidates = binding.candidates;
  const warnings: BindingWarning[] = [];
  for (const [index, batch] of binding.batches.entries()) {
    const bound = await call(`binding${index}`, batch.prompt, BINDING_INSTRUCTIONS, BINDING_SCHEMA, (value) => {
      const next = structuredClone(output);
      const notices = applyBinding(value, batch, next, input.extractInput);
      Object.assign(output, next);
      return notices;
    }, bindingRepairSchema(batch));
    warnings.push(...bound);
  }
  // Role-aware, whole-item projection: never cut a condition in half to fit the cache.
  const summary: string[] = []; const evidence: QuoteRef[] = [];
  for (const claim of output.claims) {
    const line = `[${claim.basis}/${claim.speech_act}] ${claim.statement}`;
    if (graphemeCount([...summary, line].join("\n")) > 480) continue;
    const unique = [...new Map([...evidence, ...claim.evidence].map((quote) => [JSON.stringify(quote), quote])).values()];
    if (unique.length > 4) continue;
    summary.push(line); evidence.splice(0, evidence.length, ...unique);
  }
  output.summary = summary.length ? { text: summary.join("\n"), evidence } : null;
  validateExtractOutputShape(output, input.extractInput);
  const called = stages.filter((stage) => !stage.reused);
  const known = called.every((stage) => stage.usage !== null);
  const usage = known ? { prompt_tokens: called.reduce((sum, stage) => sum + (stage.usage!.prompt_tokens ?? 0), 0),
    cached_tokens: called.reduce((sum, stage) => sum + stage.usage!.cached_tokens, 0),
    output_tokens: called.reduce((sum, stage) => sum + stage.usage!.output_tokens, 0),
    total_tokens: called.reduce((sum, stage) => sum + (stage.usage!.total_tokens ?? 0), 0) } : null;
  return { output, evidence: { reported_model: stages[0]!.reported_model, usage, duration_ms: Date.now() - started,
    request_wire: stages[0]!.request_wire, stages, warnings } };
}

export class MemoryExtractDispositionError extends Error {
  constructor(readonly disposition: "needs_context" | "unsupported", readonly output: unknown, readonly evidence: StageEvidence & { reused: boolean }) {
    super(`memory_extract_${disposition}`);
  }
}

export class MemoryExtractAttemptError extends Error {
  constructor(
    code: string,
    readonly output: unknown,
    readonly providerEvidence: unknown,
    cause?: unknown,
    readonly repairExhausted = false,
  ) {
    super(code, { cause });
  }
}

export function extractOutputSchema(): Record<string, unknown> {
  return buildExtractOutputSchema(false);
}

function buildExtractOutputSchema(compact: boolean): Record<string, unknown> {
  const quoteShape = object(
    {
      unit_ref: {
        ...string(64),
        description:
          "A ref from source_units.ref, context_units.ref, or candidates.evidence.ref; never a node or local ref.",
      },
      quote: {
        ...unicodeString(480),
        description:
          "A non-empty exact source substring, with NFC canonical equivalence accepted only when literal matching fails; maximum 480 Unicode grapheme clusters.",
      },
      occurrence: {
        ...integer(),
        description: "The 0-based matching occurrence; use 0 for the first or only match.",
      },
    },
    ["unit_ref", "quote", "occurrence"],
  );
  const quote = compact ? schemaRef("Quote") : quoteShape;
  const evidenceShape = {
    ...array(quote, 4),
    minItems: 1,
    description:
      "One to four quotes, including at least one quote from a current source unit.",
  };
  const evidence = compact ? schemaRef("Evidence") : evidenceShape;
  const create = object(
    {
      kind: { type: "string", enum: ["create"] },
      provisional: { type: "boolean" },
      identity_scope: { type: "string", enum: ["user", "project"] },
    },
    ["kind", "provisional", "identity_scope"],
  );
  const reuse = object(
    {
      kind: { type: "string", enum: ["reuse"] },
      node_ref: string(64),
      reason: {
        type: "string",
        enum: [
          "bound_source",
          "explicit_alias",
          "named_context",
          "deictic_reference",
        ],
      },
      evidence: {
        ...evidence,
        description:
          IDENTITY_REUSE_GUIDANCE,
      },
    },
    ["kind", "node_ref", "reason", "evidence"],
  );
  const resolutionShape = { anyOf: [create, reuse] };
  const resolution = compact ? schemaRef("Resolution") : resolutionShape;
  const node = object(
    {
      local_ref: string(64),
      type: { type: "string", enum: ["entity", "project"] },
      label: unicodeString(256),
      resolution,
      aliases: array(
        object({ text: unicodeString(256), evidence }, ["text", "evidence"]),
        8,
      ),
      evidence,
    },
    ["local_ref", "type", "label", "resolution", "aliases", "evidence"],
  );
  const claim = object(
    {
      local_ref: string(64),
      type: {
        type: "string",
        enum: ["preference", "goal", "constraint", "decision", "memory_atom"],
      },
      resolution,
      statement: unicodeString(1024),
      subject_ref: { ...nullableString(64), description: OUTPUT_ENDPOINT_DESCRIPTION },
      object_ref: { ...nullableString(64), description: OUTPUT_ENDPOINT_DESCRIPTION },
      speech_act: {
        type: "string",
        enum: ["assertion", "question", "proposal"],
      },
      basis: {
        type: "string",
        enum: [
          "user_statement",
          "assistant_statement",
          "reviewed_task",
          "inference",
        ],
        description:
          "The basis of the current observation. user_statement requires every quoted current source unit supporting this claim or its relations to have role user; assistant_statement requires role assistant. Historical candidate evidence belongs in resolution.evidence and never changes this basis. inference and reviewed_task are not role-mismatch bypasses.",
      },
      polarity: {
        type: "string",
        enum: ["positive", "negative", "unspecified"],
        description: "Polarity of the assertion's predicate. Keep the predicate fixed when negating: likes plus negative means not liking; dislikes plus negative means not disliking.",
      },
      condition: nullableUnicodeString(1024),
      valid_from: nullableString(),
      valid_to: nullableString(),
      salience: { type: "string", enum: ["high", "normal", "unspecified"] },
      evidence: {
        ...evidence,
        description:
          "Current observation evidence. Its quoted current source roles must match basis; historical candidate evidence belongs in resolution.evidence and does not replace this evidence.",
      },
    },
    [
      "local_ref",
      "type",
      "resolution",
      "statement",
      "subject_ref",
      "object_ref",
      "speech_act",
      "basis",
      "polarity",
      "condition",
      "valid_from",
      "valid_to",
      "salience",
      "evidence",
    ],
  );
  const relation = object(
    {
      from_ref: { ...string(64), description: OUTPUT_ENDPOINT_DESCRIPTION },
      to_ref: { ...string(64), description: OUTPUT_ENDPOINT_DESCRIPTION },
      relation: {
        type: "string",
        enum: [
          "likes",
          "dislikes",
          "decided",
          "belongs_to",
          "depends_on",
          "related_to",
        ],
      },
      claim_ref: { ...string(64), description: RELATION_CLAIM_GUIDANCE },
      evidence: {
        ...evidence,
        description:
          "Current observation evidence for this relation. Quoted current source roles must match the referenced claim basis; historical candidate evidence belongs in resolution.evidence.",
      },
    },
    ["from_ref", "to_ref", "relation", "claim_ref", "evidence"],
  );
  const correction = object(
    {
      previous_claim_ref: { ...string(64), description: TYPED_CORRECTION_GUIDANCE },
      replacement_claim_ref: { ...string(64), description: "A local_ref declared in this output's claims." },
      relation: { type: "string", enum: ["supersedes", "contradicts"] },
      effective_at: nullableString(),
      evidence,
    },
    [
      "previous_claim_ref",
      "replacement_claim_ref",
      "relation",
      "effective_at",
      "evidence",
    ],
  );
  const schema = object(
    {
      schema: { type: "string", enum: ["butler.memory-extract-output.v2"] },
      window_ref: string(),
      disposition: { type: "string", enum: ["processed", "unsupported"] },
      covered_unit_refs: array(string()),
      nodes: array(node, 32),
      claims: array(claim, 48),
      relations: array(relation, 64),
      corrections: array(correction, 16),
      summary: {
        anyOf: [
          object({ text: unicodeString(480), evidence }, ["text", "evidence"]),
          { type: "null" },
        ],
      },
    },
    [
      "schema",
      "window_ref",
      "disposition",
      "covered_unit_refs",
      "nodes",
      "claims",
      "relations",
      "corrections",
      "summary",
    ],
  );
  return compact
    ? withoutDescriptions({ ...schema, $defs: { Quote: quoteShape, Evidence: evidenceShape, Resolution: resolutionShape } }) as Record<string, unknown>
    : schema;
}

function schemaRef(name: string): Record<string, unknown> {
  return { $ref: `#/$defs/${name}` };
}

function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "description")
    .map(([key, item]) => [key, withoutDescriptions(item)]));
}

function validateExtractOutputShape(
  value: unknown,
  input: ExtractInput,
): ExtractOutput {
  if (
    !record(value) ||
    !["butler.memory-extract-output.v2", "butler.memory-extract-output.v3"].includes(String(value.schema)) ||
    value.window_ref !== input.window_ref
  )
    throw new Error("memory_extract_invalid_output");
  if (record(value) && (
    (Array.isArray(value.nodes) && value.nodes.length > 32) ||
    (Array.isArray(value.claims) && value.claims.length > 48) ||
    (Array.isArray(value.relations) && value.relations.length > 64) ||
    (Array.isArray(value.corrections) && value.corrections.length > 16) ||
    Buffer.byteLength(JSON.stringify(value)) > 65536
  )) throw new Error("memory_extract_output_exceeds_budget");
  const schemaValidation = validateJsonObjectSchema(
    value.schema === "butler.memory-extract-output.v3"
      ? { ...value, schema: "butler.memory-extract-output.v2", claims: (value.claims as ExtractOutput["claims"]).map(({ requirement: _requirement, ...claim }) => claim) }
      : value,
    extractOutputSchema(),
  );
  if (!schemaValidation.ok) throw new Error("memory_extract_invalid_output");
  const output = value as unknown as ExtractOutput;
  for (const key of [
    "covered_unit_refs",
    "nodes",
    "claims",
    "relations",
    "corrections",
  ] as const)
    if (!Array.isArray(output[key]))
      throw new Error("memory_extract_invalid_output");
  if (output.disposition === "unsupported") {
    if (
      output.covered_unit_refs.length ||
      output.nodes.length ||
      output.claims.length ||
      output.relations.length ||
      output.corrections.length ||
      output.summary !== null
    )
      throw new Error("memory_extract_invalid_output");
  } else if (
    output.disposition !== "processed" ||
    !sameSet(
      output.covered_unit_refs,
      input.source_units.map((unit) => unit.ref),
    )
  )
    throw new Error("memory_extract_invalid_output");
  const refs = new Set<string>();
  for (const item of [...output.nodes, ...output.claims]) {
    if (!asciiRef(item.local_ref) || refs.has(item.local_ref))
      throw new Error("memory_extract_invalid_output");
    refs.add(item.local_ref);
  }
  if (
    output.nodes.some((node) => node.aliases.length > 8) ||
    output.claims.some(
      (claim) =>
        claim.condition !== null && graphemeCount(claim.condition) > 1024,
    ) ||
    (output.summary !== null && graphemeCount(output.summary.text) > 480) ||
    output.corrections.some(
      (correction) =>
        !asciiRef(correction.previous_claim_ref) ||
        !asciiRef(correction.replacement_claim_ref) ||
        correction.evidence.length > 4,
    )
  ) {
    throw new Error("memory_extract_invalid_output");
  }
  return output;
}

function object(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties, required };
}
function array(items: unknown, maxItems?: number): Record<string, unknown> {
  return { type: "array", items, ...(maxItems ? { maxItems } : {}) };
}
function string(maxLength?: number): Record<string, unknown> {
  return { type: "string", ...(maxLength ? { maxLength } : {}) };
}
function unicodeString(graphemeLimit: number): Record<string, unknown> {
  return {
    type: "string",
    description: `Maximum ${graphemeLimit} Unicode grapheme clusters; enforced after extraction.`,
  };
}
function integer(): Record<string, unknown> {
  return { type: "integer", minimum: 0 };
}
function nullableString(maxLength?: number): Record<string, unknown> {
  return { anyOf: [string(maxLength), { type: "null" }] };
}
function nullableUnicodeString(graphemeLimit: number): Record<string, unknown> {
  return { anyOf: [unicodeString(graphemeLimit), { type: "null" }] };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asciiRef(value: string): boolean {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= 64 &&
    /^[\x21-\x7e]+$/u.test(value)
  );
}
function sameSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value))
  );
}
