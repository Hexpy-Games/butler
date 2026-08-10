import {
  resolveContextBudgetConfig,
  tokenBudgetToChars,
} from "../../context/budget.ts";

export type GuidedCompactReplayBudget = {
  inputCapacityTokens: number;
  newestRecordBytes: number;
  newestBatchBytes: number;
  selectedViewTokens: number;
  workContextCharacters: number;
};

export function resolveGuidedCompactReplayBudget(
  modelRef: string,
): GuidedCompactReplayBudget {
  const config = resolveContextBudgetConfig(modelRef);
  const inputCapacityTokens = Math.max(
    1,
    config.contextWindowTokens - config.reservedOutputTokens -
      config.reservedToolTokens,
  );
  const newestBatchTokens = Math.max(1, Math.floor(inputCapacityTokens * 0.24));
  const newestRecordTokens = Math.max(1, Math.floor(newestBatchTokens * 0.5));
  return {
    inputCapacityTokens,
    newestRecordBytes: tokenBudgetToChars(newestRecordTokens),
    newestBatchBytes: tokenBudgetToChars(newestBatchTokens),
    selectedViewTokens: Math.max(1, Math.floor(inputCapacityTokens * 0.12)),
    workContextCharacters: tokenBudgetToChars(
      Math.max(1, Math.floor(inputCapacityTokens * 0.12)),
    ),
  };
}
