import { sanitizePublicText } from "../../events/turn-events.ts";

type PublicWorkActionDisplayInput = {
  actionKey: string;
  description: string;
  effect?: { target?: string };
};

export function publicWorkActionDisplay(
  action: PublicWorkActionDisplayInput,
  fallback: string,
): string {
  const actionKey = sanitizePublicText(action.actionKey, "").trim();
  const description = sanitizePublicText(action.description, "").trim();
  if (
    description &&
    description !== actionKey &&
    isGenericOrOpaqueActionKey(actionKey) &&
    !isGenericOrOpaqueActionKey(description)
  ) {
    return compactPublicText(description);
  }
  const target = publicWorkActionTarget(action);
  return target
    ? compactPublicText(target)
    : compactPublicText(sanitizePublicText(fallback, ""));
}

function publicWorkActionTarget(
  action: PublicWorkActionDisplayInput,
): string {
  const actionKey = sanitizePublicText(action.actionKey, "").trim();
  if (!action.effect?.target || !isGenericOrOpaqueActionKey(actionKey)) return "";
  return sanitizePublicText(action.effect.target, "").trim();
}

function compactPublicText(value: string): string {
  const text = value.replace(/\s+/gu, " ");
  const characters = [...text];
  if (characters.length <= 32) return text;
  const prefix = characters.slice(0, 31).join("");
  const lastSpace = prefix.lastIndexOf(" ");
  const bounded = lastSpace >= 16 ? prefix.slice(0, lastSpace) : prefix;
  return `${bounded.trimEnd()}…`;
}

function isGenericOrOpaqueActionKey(value: string): boolean {
  return LEGACY_STAGE_ACTION_KEYS.has(value) || OPAQUE_ACTION_KEY_PATTERN.test(value);
}

const OPAQUE_ACTION_KEY_PATTERN =
  /^(?:[a-z0-9]+(?:_[a-z0-9]+)+|[a-z0-9]+(?:-[a-z0-9]+)+)$/u;

const LEGACY_STAGE_ACTION_KEYS = new Set([
  "inspect",
  "plan",
  "implement",
  "validate",
  "release",
  "closeout",
]);
