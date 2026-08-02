import type {
  BtccAgentLoopEvent,
  BtccAgentLoopInput,
  BtccAgentLoopMessage,
  BtccAgentLoopToolCall,
  BtccFinalSynthesisOptions,
} from "./contracts.ts";
import type { ModelRoundResult } from "../ports/model-round.ts";

type RunModelRound = (request: {
  tools: readonly BtccAgentLoopInput["tools"][number][];
  instructions?: string;
  toolChoice?: "auto" | "required";
  iteration: number;
}) => Promise<ModelRoundResult>;

type AppendAssistantResponse = (response: ModelRoundResult) => {
  text: string;
  calls: BtccAgentLoopToolCall[];
};

export async function synthesizeFinalResponse(input: {
  synthesis?: BtccFinalSynthesisOptions;
  messages: BtccAgentLoopMessage[];
  maxIterations: number;
  runModelRound: RunModelRound;
  appendAssistantResponse: AppendAssistantResponse;
  emit: (event: BtccAgentLoopEvent) => void;
}): Promise<string | null> {
  const synthesis = input.synthesis;
  if (!synthesis) return null;
  const attempts = Math.max(1, Math.trunc(synthesis.maxAttempts ?? 1));
  let lastText = "";
  let lastResponse: ModelRoundResult | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const instructions = attempt === 0
      ? synthesis.instructions
      : synthesis.retryInstructions ?? synthesis.instructions;
    if (synthesis.includeInstructionsInMessages && attempt === 0) {
      input.messages.push({ role: "user", content: instructions });
    }
    try {
      input.emit({
        type: "model_call",
        iteration: input.maxIterations + attempt,
      });
      const response = await input.runModelRound({
        tools: [],
        instructions,
        iteration: input.maxIterations + attempt,
      });
      lastResponse = response;
      const { text } = input.appendAssistantResponse(response);
      lastText = text;
      input.emit({
        type: "model_response",
        iteration: input.maxIterations + attempt,
        text: response.text,
      });
      const accepted = (await synthesis.acceptText?.({
        text,
        response,
        attempt,
      }))?.trim() || (synthesis.acceptText ? null : text);
      if (accepted) {
        if (!text || accepted !== text) {
          input.messages.push({ role: "assistant", content: accepted });
        }
        return accepted;
      }
    } catch (error) {
      try {
        synthesis.onFailure?.(error);
      } catch {
        // Final synthesis logging is observational and cannot alter delivery.
      }
      if (synthesis.propagateFailure) throw error;
      return null;
    }
    if (attempt + 1 < attempts && synthesis.retryInstructions) {
      input.messages.push({ role: "user", content: synthesis.retryInstructions });
    }
  }
  if (synthesis.onExhausted) {
    return (await synthesis.onExhausted({ text: lastText, response: lastResponse }))?.trim() || null;
  }
  return null;
}
