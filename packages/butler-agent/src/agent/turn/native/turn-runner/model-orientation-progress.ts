import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import type { ReasoningEffort } from "../../../../integrations/providers/provider.ts";
import { sanitizePublicText } from "../../../events/turn-events.ts";
import type { RuntimeMessageLanguage } from "../../../output/messages.ts";
import {
  buildIntermediateAction,
  emitIntermediateBestEffort,
} from "../progress/turn-delivery-events.ts";

const MODEL_ORIENTATION_PROGRESS_TIMEOUT_MS = 1_500;
const MODEL_ORIENTATION_PROGRESS_MAX_CHARS = 360;

export interface ModelOrientationPromptOptions {
  signal: AbortSignal;
  reasoningEffort: ReasoningEffort;
  instructions: string;
  cacheScope: string;
}

export function startModelOrientationProgressBestEffort(input: {
  turnInput: RuntimeTurnInput;
  userText: string;
  language: RuntimeMessageLanguage;
  runTextPrompt: (
    promptText: string,
    options: ModelOrientationPromptOptions,
  ) => Promise<string>;
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
    runTextPrompt: (
      promptText: string,
      options: ModelOrientationPromptOptions,
    ) => Promise<string>;
  },
  shouldEmit: () => boolean,
): Promise<void> {
  const inboundEnvelope = "eventId" in input.turnInput.input ? input.turnInput.input : null;
  if (!inboundEnvelope || !input.turnInput.emitIntermediateDelivery) return;
  const prompt = modelOrientationPrompt(input.userText, input.language);
  const controller = new AbortController();
  const abortFromTurn = () => controller.abort(input.turnInput.signal?.reason);
  if (input.turnInput.signal?.aborted) return;
  input.turnInput.signal?.addEventListener("abort", abortFromTurn, { once: true });
  const text = await (async () => {
    try {
      return await withTimeout(
        () => input.runTextPrompt(prompt, {
          signal: controller.signal,
          reasoningEffort: "low",
          instructions: modelOrientationInstructions(input.language),
          cacheScope: "app-model-orientation",
        }),
        controller,
        MODEL_ORIENTATION_PROGRESS_TIMEOUT_MS,
      );
    } finally {
      input.turnInput.signal?.removeEventListener("abort", abortFromTurn);
    }
  })();
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
  run: () => Promise<string>,
  controller: AbortController,
  timeoutMs: number,
): Promise<string | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const promptResult = Promise.resolve().then(run);
    promptResult.catch(() => {});
    return await Promise.race([
      promptResult,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort(new Error("model orientation progress timed out"));
          resolve(null);
        }, timeoutMs);
        if (typeof timeout === "object" && typeof timeout.unref === "function") {
          timeout.unref();
        }
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function modelOrientationInstructions(language: RuntimeMessageLanguage): string {
  if (language === "ko") {
    return [
      "사용자에게 보여줄 짧은 진행 업데이트 한 문장만 작성하세요.",
      "답변, 결론, 도구 이름, 내부 지시, 숨은 추론은 쓰지 마세요.",
    ].join(" ");
  }
  return [
    "Write one short public progress sentence for the user.",
    "Do not answer the request, mention tools, internal instructions, or hidden reasoning.",
  ].join(" ");
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
