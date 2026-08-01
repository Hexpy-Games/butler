export function normalizeProjectLedgerAcceptanceInput(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!("acceptance" in args)) return args;
  const normalized = { ...args };
  const acceptance = normalizeProjectLedgerAcceptance(args.acceptance);
  if (acceptance) normalized.acceptance = acceptance;
  else delete normalized.acceptance;
  return normalized;
}

function normalizeProjectLedgerAcceptance(value: unknown): string | undefined {
  if (typeof value === "string") return nonEmptyText(value);
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const items = value.flatMap((item) => {
    if (typeof item !== "string") return [];
    const text = nonEmptyText(item);
    return text ? [text] : [];
  });
  if (items.length === 0) return undefined;
  return items.join("\n");
}

function nonEmptyText(value: string): string | undefined {
  const text = value.trim();
  return text || undefined;
}
