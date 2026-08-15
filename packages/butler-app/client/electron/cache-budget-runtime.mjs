const CACHE_BUDGET_SCHEMA = "butler.app.cache-budget.v1";
export const CACHE_BUDGET_ARGUMENT_PREFIX = "--butler-cache-budget=";

// An invalid or missing artifact disables the desktop cache instead of
// widening the working set. The renderer's durable gateway remains available.
export const DISABLED_CACHE_BUDGET = Object.freeze({
  schema: CACHE_BUDGET_SCHEMA,
  maxEntries: 0,
  maxBytes: 0,
  maxSnapshotBytes: 0,
  maxMessages: 0,
  maxComposerDraftBytes: 0,
  maxComposerDraftEntries: 0,
  maxComposerDraftAggregateBytes: 0,
});

const BOUNDS = Object.freeze({
  maxEntries: 64,
  maxBytes: 128 * 1024 * 1024,
  maxSnapshotBytes: 8 * 1024 * 1024,
  maxMessages: 10_000,
  maxComposerDraftBytes: 256 * 1024,
  maxComposerDraftEntries: 64,
  maxComposerDraftAggregateBytes: 16 * 1024 * 1024,
});

function isBoundedInteger(value, maximum) {
  return Number.isInteger(value) && value > 0 && value <= maximum;
}

export function normalizeCacheBudget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DISABLED_CACHE_BUDGET;
  }
  if (value.schema !== CACHE_BUDGET_SCHEMA) return DISABLED_CACHE_BUDGET;
  const fields = ["maxEntries", "maxBytes", "maxSnapshotBytes", "maxMessages", "maxComposerDraftBytes", "maxComposerDraftEntries", "maxComposerDraftAggregateBytes"];
  if (fields.every((field) => value[field] === 0)) return DISABLED_CACHE_BUDGET;
  if (!isBoundedInteger(value.maxEntries, BOUNDS.maxEntries) ||
      !isBoundedInteger(value.maxBytes, BOUNDS.maxBytes) ||
      !isBoundedInteger(value.maxSnapshotBytes, BOUNDS.maxSnapshotBytes) ||
      !isBoundedInteger(value.maxMessages, BOUNDS.maxMessages) ||
      value.maxSnapshotBytes > value.maxBytes) {
    return DISABLED_CACHE_BUDGET;
  }
  return Object.freeze({
    schema: CACHE_BUDGET_SCHEMA,
    maxEntries: value.maxEntries,
    maxBytes: value.maxBytes,
    maxSnapshotBytes: value.maxSnapshotBytes,
    maxMessages: value.maxMessages,
      maxComposerDraftBytes: value.maxComposerDraftBytes,
      maxComposerDraftEntries: value.maxComposerDraftEntries,
      maxComposerDraftAggregateBytes: value.maxComposerDraftAggregateBytes,
  });
}

export function readCacheBudgetArtifact(path, readText) {
  try {
    const text = readText(path);
    return normalizeCacheBudget(JSON.parse(text));
  } catch {
    return DISABLED_CACHE_BUDGET;
  }
}

export function cacheBudgetAdditionalArgument(budget) {
  const normalized = normalizeCacheBudget(budget);
  return `${CACHE_BUDGET_ARGUMENT_PREFIX}${encodeURIComponent(JSON.stringify(normalized))}`;
}

export function cacheBudgetFromArguments(argv) {
  const argument = argv.find((candidate) =>
    typeof candidate === "string" && candidate.startsWith(CACHE_BUDGET_ARGUMENT_PREFIX));
  if (!argument) return DISABLED_CACHE_BUDGET;
  try {
    return normalizeCacheBudget(JSON.parse(decodeURIComponent(
      argument.slice(CACHE_BUDGET_ARGUMENT_PREFIX.length),
    )));
  } catch {
    return DISABLED_CACHE_BUDGET;
  }
}
