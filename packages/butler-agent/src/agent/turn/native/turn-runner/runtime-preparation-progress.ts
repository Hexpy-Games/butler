import type { RuntimeMessageLanguage } from "../../../output/messages.ts";
import type { ToolProgressSummary } from "../output/tool-types.ts";
import type { NormalizedTurnPrompt } from "../context/turn-prompt.ts";

export function runtimePreparationProgressSummary(input: {
  prompt: NormalizedTurnPrompt;
  attachmentContextChars: number;
  attachmentCount: number;
  model: string;
  language: RuntimeMessageLanguage;
  useTools: boolean;
}): ToolProgressSummary {
  const ko = input.language === "ko";
  const safeLabel = ko
    ? "응답 준비 중"
    : "Preparing response";
  return {
    kind: "model",
    toolName: ko ? "모델 준비" : "Model preparation",
    safeLabel,
    workBlockLabel: safeLabel,
    inputLabel: "",
    detailRows: [],
  };
}
