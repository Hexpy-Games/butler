import type {
  SqliteGuidedEffectJournal,
  SqliteGuidedToolJournal,
} from "../../adapters/index.ts";
import type { DurableWorkContext } from "../work/index.ts";
import type { TurnRecord } from "../turn/index.ts";
import type { GuidedCompactReplayContext } from "./compact-replay-context.ts";
import { renderDurableWorkContext } from "./durable-work-tools.ts";
import { renderGuidedEffectContext } from "./guided-effect-context.ts";
import { guidedContinuationPrompt } from "./guided-turn-continuation.ts";
import type { guidedPolicy } from "./guided-turn-policy.ts";
import {
  renderGuidedPersonaInstructions,
  renderGuidedPrompt,
  renderGuidedResponseLanguage,
} from "./guided-turn-prompt.ts";

export function assembleGuidedTurnPrompt(input: {
  turn: TurnRecord;
  policy: ReturnType<typeof guidedPolicy>;
  contextDocuments: { resolve(contextRef: string): string };
  butlerData: string;
  toolJournal: SqliteGuidedToolJournal;
  effectJournal: SqliteGuidedEffectJournal;
  initialWork: DurableWorkContext | null;
  compactReplay: GuidedCompactReplayContext | null;
  compactReplayEnabled: boolean;
  compactReplayWorkCharacterLimit: number;
  continuationEnabled: boolean;
}): { prompt: string; instructions: string; responseLanguage: string } {
  const responseLanguage = renderGuidedResponseLanguage(
    input.turn,
    input.contextDocuments,
  );
  const personaInstructions = renderGuidedPersonaInstructions(
    input.turn,
    input.contextDocuments,
  );
  const prompt = renderGuidedPrompt(input.turn, {
    butlerData: input.butlerData,
    contextDocuments: input.contextDocuments,
    toolJournal: input.toolJournal,
    workContext: renderDurableWorkContext(
      input.initialWork,
      input.compactReplay,
      input.compactReplayEnabled
        ? input.compactReplayWorkCharacterLimit
        : undefined,
    ),
    effectContext: input.initialWork
      ? renderGuidedEffectContext(
          input.effectJournal.listForWork(input.initialWork.work.workId),
        )
      : "",
    compactReplay: input.compactReplay,
  });
  return {
    ...guidedContinuationPrompt({
      enabled: input.continuationEnabled,
      policy: input.policy,
      personaInstructions,
      responseLanguage,
      prompt,
    }),
    responseLanguage,
  };
}
