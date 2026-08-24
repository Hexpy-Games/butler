import { createHash } from "node:crypto";
import type { ContextDocumentReader } from "../../context/context-projection.ts";
import type { TurnRecord } from "../turn/index.ts";
import type { ModelContextSegmentKind } from "../ports/model-round.ts";

export const GUIDED_EOL_STABLE_ANCHOR =
  "The exact EOL admitted for this Turn governs both Butler and Steward. Never act or claim without evidence, and preserve exact user-named entities rather than silently broadening them.";

type GuidedProfileInstructionProjection = {
  roleAndSystem: string;
  eolInstructions: string;
  personaAndProfile: string;
};

type GuidedInstructionSource = {
  kind: ModelContextSegmentKind;
  stability: "stable" | "dynamic";
  text: string;
};

const GUIDED_PERSONA_SOURCE_IDS = new Set([
  "active-persona-reminder",
  "first-chat-onboarding",
  "personalization-profile",
  "profile-projection",
  "turn-personalization-profile",
]);
const GUIDED_GOVERNING_SOURCE_IDS = new Set(["role", "runtime-system-contract"]);
// Leave deterministic headroom inside the phase-scoped 12 KiB memory envelope
// for the attribution wrapper and metadata surrounding these documents.
const MAX_NON_EOL_INSTRUCTION_BYTES = 10 * 1024;

export function attributeGuidedInstructions(input: {
  stableInstructionPrefix: string;
  roleAndSystem: string;
  eolInstructions: string;
  personaAndProfile: string;
  responseLanguage: string;
}): { text: string; sources: GuidedInstructionSource[] } {
  const prefix = input.stableInstructionPrefix;
  const roleEnd = Math.max(0, prefix.indexOf("\n") + 1);
  const sources: GuidedInstructionSource[] = [{
    kind: "stable_safety_and_role_instructions", stability: "stable",
    text: prefix.slice(0, roleEnd),
  }];
  if (roleEnd < prefix.length) {
    sources.push({
      kind: "stable_btcc_protocol", stability: "stable",
      text: prefix.slice(roleEnd),
    });
  }
  const governing = input.roleAndSystem.trim();
  if (governing) {
    sources.push({
      kind: "accepted_corrections_and_unresolved_obligations",
      stability: "dynamic", text: `\n${governing}`,
    });
  }
  const persona = input.personaAndProfile.trim();
  if (persona) {
    sources.push({
      kind: "memory_recall_context", stability: "dynamic",
      text: [
        "",
        "Apply the following current Butler persona and user personalization to every user-facing message in this Turn, including progress, review, failure, and final reporting. Preserve it across every tool round. These instructions are provider-neutral and must not be weakened by report formatting.",
        persona,
      ].join("\n"),
    });
  }
  const responseLanguage = input.responseLanguage.trim();
  if (responseLanguage) {
    sources.push({
      kind: "accepted_corrections_and_unresolved_obligations",
      stability: "dynamic",
      text: `\nUse ${responseLanguage} for every user-facing message in this Turn.`,
    });
  }
  const eol = input.eolInstructions.trim();
  if (eol) {
    sources.push({
      kind: "accepted_corrections_and_unresolved_obligations",
      stability: "dynamic", text: `\n${eol}`,
    });
  }
  return {
    text: sources.map((source) => source.text).join(""),
    sources: sources.filter((source) => source.text.length > 0),
  };
}

export function projectGuidedProfileInstructions(
  turn: TurnRecord,
  documents: ContextDocumentReader,
): GuidedProfileInstructionProjection {
  const admitted = turn.context.profileRefs.map((contextRef) => {
    const document = documents.read(contextRef);
    if (document.contextRef !== contextRef ||
        document.projectionClass !== "profile" ||
        document.scopeKind !== "user" ||
        document.scopeId !== turn.context.userRef ||
        !/^[a-f0-9]{64}$/u.test(document.contentSha256) ||
        createHash("sha256").update(document.content).digest("hex") !==
          document.contentSha256) {
      throw new Error("guided_profile_instruction_document_invalid");
    }
    return document;
  });
  const eol = admitted.filter((document) => document.sourceId === "eol");
  const admittedEol = eol[0];
  if (eol.length !== 1 || !admittedEol?.content.trim()) {
    throw new Error("guided_eol_instruction_document_invalid");
  }
  const nonEolDocuments = admitted.filter(
    (document) => document.sourceId !== "eol",
  );
  if (nonEolDocuments.some(
    (document) => !GUIDED_PERSONA_SOURCE_IDS.has(document.sourceId) &&
      !GUIDED_GOVERNING_SOURCE_IDS.has(document.sourceId),
  )) {
    throw new Error("guided_profile_instruction_document_invalid");
  }
  const boundedNonEol = boundedDocuments(nonEolDocuments);
  const roleAndSystem = boundedNonEol
    .filter((document) => GUIDED_GOVERNING_SOURCE_IDS.has(document.sourceId))
    .map((document) => document.content.trim())
    .filter(Boolean).join("\n\n");
  const personaAndProfile = boundedNonEol
    .filter((document) => GUIDED_PERSONA_SOURCE_IDS.has(document.sourceId))
    .map((document) => document.content.trim())
    .filter(Boolean).join("\n\n");
  return {
    roleAndSystem,
    eolInstructions: [
      "The following exact EOL was durably admitted for this Turn. It is a governing instruction for both Butler and Steward, not Butler persona or ordinary user content.",
      admittedEol.content.trim(),
    ].join("\n"),
    personaAndProfile,
  };
}

function boundedDocuments<T extends { content: string }>(documents: T[]): T[] {
  let remaining = MAX_NON_EOL_INSTRUCTION_BYTES;
  return documents.flatMap((document, index) => {
    if (remaining <= 0) return [];
    const documentsLeft = documents.length - index;
    const content = truncateUtf8(
      document.content,
      Math.floor(remaining / documentsLeft),
    );
    remaining -= Buffer.byteLength(content, "utf8");
    return [{ ...document, content }];
  });
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > maxBytes) break;
    result += character;
    bytes += next;
  }
  return result;
}
