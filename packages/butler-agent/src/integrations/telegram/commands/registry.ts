// Single source of truth for butler's Telegram slash commands.
//
// Registered via setMyCommands at three scopes (default, all_private_chats,
// all_group_chats) with the same list so the command menu appears everywhere
// the bot is present. Descriptions must match Telegram's display rules:
// 1–256 chars, lowercase recommended for consistency across scopes.

export type BotCommand = { command: string; description: string };

export const BUTLER_COMMANDS: readonly BotCommand[] = [
  { command: "model",   description: "switch worker or butler model" },
  { command: "persona", description: "switch active persona preset" },
  { command: "status",  description: "system status snapshot" },
  { command: "tasks",   description: "list recent tasks, cancel any" },
  { command: "restart", description: "restart butler (confirmation)" },
  { command: "topic",   description: "manage current topic (rename, archive, info)" },
  { command: "project", description: "attach or switch a project for this topic" },
  { command: "kill",    description: "pick a running task to kill" },
  { command: "help",    description: "show command help" },
] as const;

export const SCOPES = [
  { type: "default" as const },
  { type: "all_private_chats" as const },
  { type: "all_group_chats" as const },
];

// Abstracted so tests can stub the bot API. Real caller passes
// `bot.api.setMyCommands.bind(bot.api)`.
export type SetMyCommandsFn = (
  commands: readonly BotCommand[],
  opts: { scope: { type: "default" | "all_private_chats" | "all_group_chats" } },
) => Promise<unknown>;

export type LoggerFn = (msg: string) => void;

// Registers the full list at every scope. Logs per-scope failures instead of
// swallowing them silently — a rejected promise here used to cause the whole
// bot to silently lose its menu.
export async function registerCommandsAllScopes(
  setMyCommands: SetMyCommandsFn,
  log: LoggerFn = msg => process.stderr.write(`telegram channel: ${msg}\n`),
  commands: readonly BotCommand[] = BUTLER_COMMANDS,
): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  for (const scope of SCOPES) {
    try {
      await setMyCommands(commands, { scope });
      ok++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      log(`setMyCommands failed for scope "${scope.type}": ${msg}`);
    }
  }
  return { ok, failed };
}
