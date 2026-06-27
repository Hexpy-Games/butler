import { sanitizePublicText } from "../../../events/turn-events.ts";
import type { RuntimeMessageLanguage } from "../../../output/messages.ts";
import type { ToolProgressSummary } from "../output/tool-types.ts";
import type { NormalizedTurnPrompt } from "../context/turn-prompt.ts";

const REQUEST_PREVIEW_MAX_CHARS = 96;

export function runtimePreparationProgressSummary(input: {
  prompt: NormalizedTurnPrompt;
  attachmentContextChars: number;
  attachmentCount: number;
  model: string;
  language: RuntimeMessageLanguage;
  useTools: boolean;
  userText: string;
}): ToolProgressSummary {
  const ko = input.language === "ko";
  const safeLabel = preparationSafeLabel(input.userText, input.language);
  return {
    kind: "model",
    toolName: ko ? "모델 준비" : "Model preparation",
    safeLabel,
    workBlockLabel: safeLabel,
    inputLabel: "",
    detailRows: [],
  };
}

function preparationSafeLabel(
  userText: string,
  language: RuntimeMessageLanguage,
): string {
  const ko = language === "ko";
  const fallback = ko ? "요청을 확인했습니다" : "Request received";
  const prefix = ko ? "요청 확인: " : "Request received: ";
  const preview = requestPreview(userText);
  return preview ? `${prefix}${preview}` : fallback;
}

function requestPreview(userText: string): string {
  const redacted = userText
    .replace(/(?:^|[\s"'`:=])\/(?:Users|private|tmp|var\/folders|home|Volumes|opt|usr|etc)\S*/gu, " [redacted path]")
    .replace(/(?:^|[\s"'`:=])(?:[A-Za-z]:\\|\\\\[^\s\\]+\\[^\s\\]+)\S*/gu, " [redacted path]")
    .replace(/\s+/gu, " ")
    .trim();
  const truncated = redacted.length > REQUEST_PREVIEW_MAX_CHARS
    ? `${redacted.slice(0, REQUEST_PREVIEW_MAX_CHARS - 1).trimEnd()}...`
    : redacted;
  return sanitizePublicText(truncated, "");
}
