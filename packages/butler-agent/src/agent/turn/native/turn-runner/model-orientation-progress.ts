import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import { sanitizePublicText } from "../../../events/turn-events.ts";
import type { RuntimeMessageLanguage } from "../../../output/messages.ts";
import {
  buildIntermediateAction,
  emitIntermediateBestEffort,
} from "../progress/turn-delivery-events.ts";

const MODEL_ORIENTATION_PROGRESS_TIMEOUT_MS = 5_000;
const MODEL_ORIENTATION_PROGRESS_MAX_CHARS = 360;

export function startModelOrientationProgressBestEffort(input: {
  turnInput: RuntimeTurnInput;
  userText: string;
  language: RuntimeMessageLanguage;
  runTextPrompt: (promptText: string) => Promise<string>;
}): { stop: () => void; done: Promise<void> } {
  let active = true;
  const done = emitModelOrientationProgress(input, () => active).catch(() => {});
  return {
    stop: () => {
      active = false;
    },
    done,
  };
}

async function emitModelOrientationProgress(
  input: {
    turnInput: RuntimeTurnInput;
    userText: string;
    language: RuntimeMessageLanguage;
    runTextPrompt: (promptText: string) => Promise<string>;
  },
  shouldEmit: () => boolean,
): Promise<void> {
  const inboundEnvelope = "eventId" in input.turnInput.input ? input.turnInput.input : null;
  if (!inboundEnvelope || !input.turnInput.emitIntermediateDelivery) return;
  const prompt = modelOrientationPrompt(input.userText, input.language);
  const promptResult = input.runTextPrompt(prompt);
  const text = await withTimeout(promptResult, MODEL_ORIENTATION_PROGRESS_TIMEOUT_MS);
  promptResult.catch(() => {});
  if (!shouldEmit() || !text) return;
  const visibleText = publicOrientationText(text);
  if (!visibleText) return;
  await emitIntermediateBestEffort(
    input.turnInput,
    buildIntermediateAction({
      envelope: inboundEnvelope,
      suffix: "model-orientation-progress",
      text: visibleText,
      metadata: {
        phase: "model_orientation",
        modelAuthored: true,
      },
    }),
    {
      source: "runtime/native-tool-loop.ts#model-orientation-progress",
      phase: "model_orientation",
      modelAuthored: true,
    },
  );
}

async function withTimeout(
  promise: Promise<string>,
  timeoutMs: number,
): Promise<string | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
        if (typeof timeout === "object" && typeof timeout.unref === "function") {
          timeout.unref();
        }
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function publicOrientationText(value: string): string {
  const withoutEnvelope = value
    .replace(/<\/?butler_final_answer>/giu, "")
    .replace(/^\s*(?:summary|rationale|next_step)\s*:/gimu, "")
    .trim();
  const sanitized = sanitizePublicText(withoutEnvelope, "");
  if (!sanitized) return "";
  if (/tool_call|dispatch_worker|resume_worker|system prompt|internal/i.test(sanitized)) {
    return "";
  }
  return sanitized.slice(0, MODEL_ORIENTATION_PROGRESS_MAX_CHARS).trim();
}

function modelOrientationPrompt(userText: string, language: RuntimeMessageLanguage): string {
  if (language === "ko") {
    return [
      "사용자에게 즉시 보여줄 진행 업데이트만 작성하세요.",
      "답변이나 결론을 쓰지 말고, 지금 무엇을 확인하거나 처리할지 한두 문장으로 구체적으로 말하세요.",
      "내부 정책, 시스템 지시, 도구 이름, 함수 호출, 원시 JSON, 숨은 추론을 언급하지 마세요.",
      "불확실한 사실을 단정하지 마세요.",
      "",
      `사용자 요청: ${userText}`,
    ].join("\n");
  }
  return [
    "Write only an immediate progress update for the user.",
    "Do not answer the request yet. In one or two concrete sentences, say what you are going to check or handle now.",
    "Do not mention internal policy, system instructions, tool names, function calls, raw JSON, or hidden reasoning.",
    "Do not assert uncertain facts as conclusions.",
    "",
    `User request: ${userText}`,
  ].join("\n");
}
