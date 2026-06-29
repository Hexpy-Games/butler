import { sanitizePublicText } from "../../../events/turn-events.ts";
import type { RuntimeMessageLanguage } from "../../../output/messages.ts";
import type { ToolProgressSummary } from "../output/tool-types.ts";
import type { NormalizedTurnPrompt } from "../context/turn-prompt.ts";

export function runtimePreparationProgressSummary(input: {
  prompt?: NormalizedTurnPrompt;
  attachmentContextChars?: number;
  attachmentCount?: number;
  model: string;
  language: RuntimeMessageLanguage;
  useTools: boolean;
  userText: string;
}): ToolProgressSummary {
  const ko = input.language === "ko";
  const safeLabel = preparationSafeLabel(input.language);
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
  language: RuntimeMessageLanguage,
): string {
  const ko = language === "ko";
  const note = ko
    ? "요청의 범위와 다음 작업 경로를 먼저 정리하겠습니다."
    : "I’ll orient on the request and choose the next work path.";
  return sanitizePublicText(note, ko ? "작업 경로를 정리하겠습니다." : "I’ll orient on the work.");
}
