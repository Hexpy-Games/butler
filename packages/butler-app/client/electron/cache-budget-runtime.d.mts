export interface AppCacheBudget {
  schema: "butler.app.cache-budget.v1";
  maxEntries: number;
  maxBytes: number;
  maxSnapshotBytes: number;
  maxMessages: number;
  maxComposerDraftBytes: number;
  maxComposerDraftEntries: number;
  maxComposerDraftAggregateBytes: number;
}

export const CACHE_BUDGET_ARGUMENT_PREFIX: "--butler-cache-budget=";
export const DISABLED_CACHE_BUDGET: Readonly<AppCacheBudget>;
export function normalizeCacheBudget(value: unknown): Readonly<AppCacheBudget>;
export function readCacheBudgetArtifact(
  path: string,
  readText: (path: string) => string,
): Readonly<AppCacheBudget>;
export function cacheBudgetAdditionalArgument(
  budget: unknown,
): string;
export function cacheBudgetFromArguments(
  argv: readonly string[],
): Readonly<AppCacheBudget>;
