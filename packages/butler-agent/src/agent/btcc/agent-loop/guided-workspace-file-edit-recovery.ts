import { createHash } from "node:crypto";
import {
  locateExactText,
  type ExactTextLocation,
} from "../../tools/file-tools/edit_file/index.ts";
import type { GuidedEffectRecoveryHint } from "../effects/index.ts";
import {
  createGuidedWorkspaceFileEditEffectAdapter,
  guidedWorkspaceEditInputSha256,
  normalizedGuidedWorkspaceEditCandidate,
  type GuidedWorkspaceFileEditInput,
} from "./guided-workspace-file-edit-adapter.ts";
import { guidedWorkspaceBytesSha256 } from "./guided-workspace-file-edit-observation.ts";

const LEGACY_RECOVERY_MAX_CANDIDATES = 16;
const LEGACY_RECOVERY_MAX_WORK_UNITS = 1_000_000;

type DecodedGuidedWorkspaceEdit = {
  path: string;
  startLine?: number;
  oldText: string;
  newText: string;
};

type LegacyRecoveryBudget = {
  candidateCount: number;
  workUnits: number;
};

export function recoverLegacyInput(input: {
  adapter: ReturnType<typeof createGuidedWorkspaceFileEditEffectAdapter>;
  decoded: DecodedGuidedWorkspaceEdit;
  observedText: string;
  observedSha256: string;
  priorInputSha256: string;
}): GuidedWorkspaceFileEditInput | null {
  const budget: LegacyRecoveryBudget = {
    candidateCount: 0,
    workUnits: 0,
  };
  const matches: GuidedWorkspaceFileEditInput[] = [];
  const beforeLocations = boundedExactTextLocations(
    input.observedText,
    input.decoded.oldText,
    budget,
  );
  if (!beforeLocations) return null;
  for (const location of beforeLocations) {
    if (input.decoded.oldText === input.decoded.newText) continue;
    if (!takeLegacyRecoveryCandidate(budget)) return null;
    if (!spendLegacyRecoveryWork(budget, input.observedText.length)) return null;
    const candidate = normalizedGuidedWorkspaceEditCandidate({
      adapter: input.adapter,
      decoded: input.decoded,
      location,
    }, {
      beforeSha256: input.observedSha256,
      afterSha256: textSha256WithReplacement(
        input.observedText,
        location.offset,
        input.decoded.oldText.length,
        input.decoded.newText,
      ),
    });
    if (guidedWorkspaceEditInputSha256(candidate) === input.priorInputSha256) {
      matches.push(candidate);
    }
  }
  if (input.decoded.newText) {
    if (!spendLegacyRecoveryWork(budget, input.observedText.length)) return null;
    const afterStateHash = textSha256(input.observedText);
    if (afterStateHash === input.observedSha256) {
      const afterLocations = boundedExactTextLocations(
        input.observedText,
        input.decoded.newText,
        budget,
      );
      if (!afterLocations) return null;
      for (const afterLocation of afterLocations) {
        const beforeTextLength = input.observedText.length -
          input.decoded.newText.length + input.decoded.oldText.length;
        if (!spendLegacyRecoveryWork(budget, beforeTextLength)) return null;
        const beforeText = input.observedText.slice(0, afterLocation.offset) +
          input.decoded.oldText +
          input.observedText.slice(
            afterLocation.offset + input.decoded.newText.length,
          );
        if (beforeText === input.observedText) continue;
        const beforeLocations = boundedExactTextLocations(
          beforeText,
          input.decoded.oldText,
          budget,
        );
        if (!beforeLocations) return null;
        if (!spendLegacyRecoveryWork(budget, beforeText.length)) return null;
        const beforeSha256 = textSha256(beforeText);
        for (const beforeLocation of beforeLocations) {
          if (!takeLegacyRecoveryCandidate(budget)) return null;
          const candidate = normalizedGuidedWorkspaceEditCandidate({
            adapter: input.adapter,
            decoded: input.decoded,
            location: beforeLocation,
          }, {
            beforeSha256,
            afterSha256: afterStateHash,
          });
          if (guidedWorkspaceEditInputSha256(candidate) === input.priorInputSha256) {
            matches.push(candidate);
          }
        }
      }
    }
  }

  return matches.length === 1 ? matches[0]! : null;
}

export function recoverDurableInput(input: {
  adapter: ReturnType<typeof createGuidedWorkspaceFileEditEffectAdapter>;
  decoded: DecodedGuidedWorkspaceEdit;
  observedText: string;
  observedSha256: string;
  priorInputSha256: string;
  priorRecoveryHint: GuidedEffectRecoveryHint;
}): GuidedWorkspaceFileEditInput | null {
  if (input.priorRecoveryHint.capability !== "edit_file") return null;
  let candidate: GuidedWorkspaceFileEditInput;
  try {
    candidate = input.adapter.normalizeInput({
      path: input.decoded.path,
      start_line: input.priorRecoveryHint.startLine,
      old_text: input.decoded.oldText,
      new_text: input.decoded.newText,
      before_sha256: input.priorRecoveryHint.beforeSha256,
      after_sha256: input.priorRecoveryHint.afterSha256,
    });
  } catch {
    return null;
  }
  if (
    guidedWorkspaceEditInputSha256(candidate) !== input.priorInputSha256 ||
    (input.observedSha256 !== candidate.before_sha256 &&
      input.observedSha256 !== candidate.after_sha256)
  ) {
    return null;
  }
  if (input.observedSha256 === candidate.before_sha256) {
    const location = locateExactText({
      text: input.observedText,
      oldText: candidate.old_text,
      startLine: candidate.start_line,
    });
    if (!location.ok || location.value.startLine !== candidate.start_line) {
      return null;
    }
  }
  return candidate;
}

function boundedExactTextLocations(
  text: string,
  oldText: string,
  budget: LegacyRecoveryBudget,
): ExactTextLocation[] | null {
  if (!spendLegacyRecoveryWork(budget, text.length)) return null;
  const locations: ExactTextLocation[] = [];
  let searchFrom = 0;
  let scannedTo = 0;
  let startLine = 1;
  while (searchFrom <= text.length - oldText.length) {
    const offset = text.indexOf(oldText, searchFrom);
    if (offset < 0) break;
    if (locations.length >= LEGACY_RECOVERY_MAX_CANDIDATES) return null;
    while (scannedTo < offset) {
      if (text[scannedTo] === "\n") startLine += 1;
      scannedTo += 1;
    }
    locations.push({ offset, startLine });
    searchFrom = offset + 1;
  }
  return locations;
}

function spendLegacyRecoveryWork(
  budget: LegacyRecoveryBudget,
  units: number,
): boolean {
  const normalizedUnits = Math.max(1, units);
  if (
    normalizedUnits > LEGACY_RECOVERY_MAX_WORK_UNITS ||
    budget.workUnits > LEGACY_RECOVERY_MAX_WORK_UNITS - normalizedUnits
  ) {
    return false;
  }
  budget.workUnits += normalizedUnits;
  return true;
}

function takeLegacyRecoveryCandidate(
  budget: LegacyRecoveryBudget,
): boolean {
  if (budget.candidateCount >= LEGACY_RECOVERY_MAX_CANDIDATES) return false;
  budget.candidateCount += 1;
  return true;
}

function textSha256WithReplacement(
  text: string,
  offset: number,
  replacedLength: number,
  replacement: string,
): string {
  const hash = createHash("sha256");
  hash.update(text.slice(0, offset), "utf8");
  hash.update(replacement, "utf8");
  hash.update(text.slice(offset + replacedLength), "utf8");
  return hash.digest("hex");
}

function textSha256(value: string): string {
  return guidedWorkspaceBytesSha256(Buffer.from(value, "utf8"));
}
