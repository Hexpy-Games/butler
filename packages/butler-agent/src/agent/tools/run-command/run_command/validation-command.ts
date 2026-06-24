const VALIDATION_COMMAND_PATTERNS = [
  /^(?:bun|\$\{BUTLER_BUN:-bun\})(?:\s+--silent)?\s+run(?:\s+--silent)?\s+check(?::run|:verbose)?\b/u,
  /^(?:bun|\$\{BUTLER_BUN:-bun\})(?:\s+--silent)?\s+run(?:\s+--silent)?\s+test:unit(?::run)?\b/u,
  /^(?:bun|\$\{BUTLER_BUN:-bun\})(?:\s+--silent)?\s+run(?:\s+--silent)?\s+test\b/u,
  /^(?:bun|\$\{BUTLER_BUN:-bun\})(?:\s+--silent)?\s+run(?:\s+--silent)?\s+ops\/scripts\/validate\.ts\s+(?:check:run|test:unit:run)\b/u,
  /^bun\s+test\b/u,
  /^(?:bun|\$\{BUTLER_BUN:-bun\})(?:\s+--silent)?\s+run(?:\s+--silent)?\s+lint\b/u,
  /^(?:bun|\$\{BUTLER_BUN:-bun\})(?:\s+--silent)?\s+run(?:\s+--silent)?\s+typecheck\b/u,
  /^tsc\b/u,
  /^npm\s+(?:--prefix\s+\S+\s+)?run(?:\s+--silent)?\s+(?:lint|typecheck|test)\b/u,
  /^npm\s+test\b/u,
  /^node\s+--test\b/u,
  /^(?:pnpm|yarn)\s+(?:run\s+)?(?:lint|typecheck|test)\b/u,
  /^(?:project-ledger|packages\/project-ledger\/bin\/project-ledger|resources\/skills\/project-ledger\/bin\/project-ledger)\s+check\b/u,
  /^git\s+diff\b.*\s--check\b/u,
];

export function normalizeValidationCommand(command: string): string {
  return command
    .trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/u, "")
    .replace(/\s+/gu, " ");
}

export function isValidationCommand(command: string): boolean {
  const normalized = normalizeValidationCommand(command);
  return VALIDATION_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function validationCommandKey(command: string): string {
  const normalized = normalizeValidationCommand(command);
  if (isTypecheckCommand(normalized)) return "validation:typecheck";
  if (isLintCommand(normalized)) return "validation:lint";
  if (isTestCommand(normalized)) return "validation:test";
  if (isCheckCommand(normalized)) return "validation:check";
  if (/^git\s+diff\b.*\s--check\b/u.test(normalized)) return "validation:diff-check";
  return normalized;
}

function isTypecheckCommand(command: string): boolean {
  return /\btypecheck\b|\btsc\b/u.test(command);
}

function isLintCommand(command: string): boolean {
  return /\blint\b|\beslint\b/u.test(command);
}

function isTestCommand(command: string): boolean {
  return /^node\s+--test\b/u.test(command) ||
    /^bun\s+test\b/u.test(command) ||
    /^npm\s+test\b/u.test(command) ||
    /\b(?:run\s+)?test(?::unit(?::run)?)?\b/u.test(command);
}

function isCheckCommand(command: string): boolean {
  return /\bcheck(?::run|:verbose)?\b/u.test(command) ||
    /\bproject-ledger\b.*\bcheck\b/u.test(command);
}
