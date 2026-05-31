// Callback-query router.
//
// Callback payload format: `prefix:action:payload`
//   prefix  — command namespace ("model", "persona", "tasks", …)
//   action  — state-machine transition within that command
//   payload — optional string (may contain colons; matched as the remainder)
//
// Example: "model:set:openai/gpt-5.5-codex" -> prefix=model, action=set, payload="openai/gpt-5.5-codex"
//          "restart:yes"         → prefix=restart, action=yes, payload=""

export type ParsedCallback = {
  prefix: string
  action: string
  payload: string
};

export type CallbackHandler = (parsed: ParsedCallback, ctx: CallbackCtx) => Promise<void> | void;

export type CallbackCtx = {
  chatId: string
  userId: string
  messageId: number | undefined
  answer: (text?: string, opts?: { showAlert?: boolean }) => Promise<void>
  editText: (text: string, opts?: { reply_markup?: unknown; parse_mode?: string }) => Promise<void>
  sendText: (text: string, opts?: { reply_markup?: unknown; parse_mode?: string }) => Promise<void>
};

// Split on the *first two* colons so payload can legitimately contain colons.
// "a:b:c:d" → ["a","b","c:d"]. No colons → null. Trailing colon → empty payload.
export function parseCallback(data: string): ParsedCallback | null {
  const m = /^([^:]+):([^:]+)(?::(.*))?$/.exec(data);
  if (!m) return null;
  return { prefix: m[1]!, action: m[2]!, payload: m[3] ?? "" };
}

export class CallbackRouter {
  private readonly handlers = new Map<string, CallbackHandler>();

  register(prefix: string, handler: CallbackHandler): void {
    if (this.handlers.has(prefix)) {
      throw new Error(`callback prefix already registered: ${prefix}`);
    }
    this.handlers.set(prefix, handler);
  }

  has(prefix: string): boolean {
    return this.handlers.has(prefix);
  }

  async dispatch(data: string, ctx: CallbackCtx): Promise<"handled" | "unknown" | "malformed"> {
    const parsed = parseCallback(data);
    if (!parsed) return "malformed";
    const handler = this.handlers.get(parsed.prefix);
    if (!handler) return "unknown";
    await handler(parsed, ctx);
    return "handled";
  }
}
