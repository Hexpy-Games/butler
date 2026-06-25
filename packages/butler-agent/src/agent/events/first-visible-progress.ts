import { sanitizePublicText } from "./turn-events.ts";

export const FIRST_VISIBLE_PROGRESS_WORK_BLOCK_PREFIX = "first-progress";
export const FIRST_VISIBLE_PROGRESS_FALLBACK_NOTE = "Preparing to work on this.";
export const FIRST_VISIBLE_PROGRESS_DEFAULT_SOURCE = "runtime-derived";
export const FIRST_VISIBLE_PROGRESS_ASSISTANT_SOURCE = "assistant-authored";
export const FIRST_VISIBLE_PROGRESS_ACCEPTED_SAFETY_STATUS = "accepted";
export const FIRST_VISIBLE_PROGRESS_REPAIRED_SAFETY_STATUS = "repaired";

const FIRST_VISIBLE_PROGRESS_ID_FRAGMENT_MAX = 48;
const UNSUPPORTED_EVIDENCE_CLAIM_PATTERN =
  /\b(?:verified|confirmed|read|searched|ran|executed|created|wrote|saved|rendered|found)\b|(?:확인했|검증했|검색했|읽었|실행했|생성했|작성했|저장했)/iu;

export function firstVisibleProgressPayload(input: {
  note: unknown;
  source?: unknown;
  safetyStatus?: unknown;
}): Record<string, unknown> {
  const note = firstVisibleProgressNote(input.note);
  const repaired = note !== String(input.note ?? "").trim();
  return {
    note,
    source: sanitizePublicText(input.source, FIRST_VISIBLE_PROGRESS_DEFAULT_SOURCE),
    safetyStatus: sanitizePublicText(
      input.safetyStatus,
      repaired
        ? FIRST_VISIBLE_PROGRESS_REPAIRED_SAFETY_STATUS
        : FIRST_VISIBLE_PROGRESS_ACCEPTED_SAFETY_STATUS,
    ),
    workBlockId: `${FIRST_VISIBLE_PROGRESS_WORK_BLOCK_PREFIX}-${stablePublicIdFragment(note)}`,
    workBlockLabel: note,
  };
}

export function firstVisibleProgressNote(value: unknown): string {
  const sanitized = sanitizePublicText(value, FIRST_VISIBLE_PROGRESS_FALLBACK_NOTE);
  if (UNSUPPORTED_EVIDENCE_CLAIM_PATTERN.test(sanitized)) {
    return FIRST_VISIBLE_PROGRESS_FALLBACK_NOTE;
  }
  return sanitized;
}

function stablePublicIdFragment(value: string): string {
  const slug = value
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, FIRST_VISIBLE_PROGRESS_ID_FRAGMENT_MAX);
  return slug || "note";
}
