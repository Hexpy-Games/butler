// Per-command handlers. Each exports:
//   1. an onCommand(ctx)     — slash-command entry point (creates session, shows first step)
//   2. a callback handler     — state-machine transitions for inline buttons
//
// Keep pure: no direct grammy imports. ctx is the minimal interface defined in
// router.ts so handlers are testable with a fake ctx.

import { execSync } from "child_process";
import type { CallbackCtx, ParsedCallback } from "./router.ts";
import type { SessionStore } from "./session.ts";
import * as butler from "./butler.ts";
import { createWorkDashboard, renderWorkDashboard } from "../../../agent/work/work-dashboard.ts";

// InlineKeyboard payload shape — grammy's InlineKeyboard.toJSON() produces this.
// Handlers emit plain objects so tests can assert structure without grammy.
export type InlineButton = { text: string; callback_data: string };
export type InlineKeyboardMarkup = { inline_keyboard: InlineButton[][] };

export type CommandDeps = {
  sessions: SessionStore
  // Bot API wrapper for slash-command entry points. Separate from CallbackCtx
  // because callbacks have message context (editText) that fresh commands don't.
  sendMessage: (chatId: string, text: string, opts?: { reply_markup?: InlineKeyboardMarkup; parse_mode?: string }) => Promise<void>
};

export type CommandCtx = {
  chatId: string
  userId: string
};

// ─── /model ─────────────────────────────────────────────────────────────────
// Step 1: [Worker] [Butler] [Cancel]   state={step:'pick-target'}
// Step 2: model list for chosen target, marking current with •

export const MODEL_PREFIX = "model";

function modelTargetKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "👷 Worker", callback_data: `${MODEL_PREFIX}:target:worker` }],
      [{ text: "🤵 Butler", callback_data: `${MODEL_PREFIX}:target:butler` }],
      [{ text: "✖ Cancel", callback_data: `${MODEL_PREFIX}:cancel:` }],
    ],
  };
}

function modelListKeyboard(target: "worker" | "butler", current: string): InlineKeyboardMarkup {
  const rows: InlineButton[][] = butler.VALID_MODELS.map(m => [{
    text: m === current ? `• ${m}` : m,
    callback_data: `${MODEL_PREFIX}:set:${m}`,
  }]);
  rows.push([{ text: "✖ Cancel", callback_data: `${MODEL_PREFIX}:cancel:` }]);
  return { inline_keyboard: rows };
}

export async function onModelCommand(deps: CommandDeps, cmd: CommandCtx): Promise<void> {
  deps.sessions.set(cmd.chatId, cmd.userId, MODEL_PREFIX, { step: "pick-target" });
  await deps.sendMessage(cmd.chatId, "Model change — pick target:", { reply_markup: modelTargetKeyboard() });
}

export async function onModelCallback(
  deps: CommandDeps,
  parsed: ParsedCallback,
  ctx: CallbackCtx,
): Promise<void> {
  if (parsed.action === "cancel") {
    deps.sessions.clear(ctx.chatId, ctx.userId, MODEL_PREFIX);
    await ctx.editText("Cancelled.");
    await ctx.answer();
    return;
  }

  const session = deps.sessions.get(ctx.chatId, ctx.userId, MODEL_PREFIX);
  if (!session) {
    await ctx.answer("This menu expired. Run /model again.", { showAlert: true });
    return;
  }

  if (parsed.action === "target") {
    if (parsed.payload !== "worker" && parsed.payload !== "butler") {
      await ctx.answer("Invalid target.");
      return;
    }
    const target = parsed.payload as "worker" | "butler";
    deps.sessions.set(ctx.chatId, ctx.userId, MODEL_PREFIX, { step: "pick-model", target });
    const current = target === "worker" ? butler.getWorkerModel() : butler.getButlerModel();
    await ctx.editText(`Pick ${target} model (current: ${current}):`, {
      reply_markup: modelListKeyboard(target, current),
    });
    await ctx.answer();
    return;
  }

  if (parsed.action === "set") {
    const target = (session as { target?: string }).target;
    if (target !== "worker" && target !== "butler") {
      await ctx.answer("Session missing target. Run /model again.", { showAlert: true });
      return;
    }
    const model = parsed.payload;
    if (!(butler.VALID_MODELS as readonly string[]).includes(model)) {
      await ctx.answer(`Unknown model: ${model}`);
      return;
    }
    try {
      if (target === "worker") butler.setWorkerModel(model);
      else butler.setButlerModel(model);
    } catch (e) {
      await ctx.answer(`Failed: ${(e as Error).message}`, { showAlert: true });
      return;
    }
    deps.sessions.clear(ctx.chatId, ctx.userId, MODEL_PREFIX);
    await ctx.editText(`${target} model set to ${model}.`);
    await ctx.answer(`✅ ${model}`);
    return;
  }

  await ctx.answer(`Unknown action: ${parsed.action}`);
}

// ─── /persona ───────────────────────────────────────────────────────────────

export const PERSONA_PREFIX = "persona";

function personaKeyboard(presets: string[], current: string): InlineKeyboardMarkup {
  const rows: InlineButton[][] = presets.map(p => [{
    text: p === current ? `• ${p}` : p,
    callback_data: `${PERSONA_PREFIX}:set:${p}`,
  }]);
  rows.push([{ text: "✖ Cancel", callback_data: `${PERSONA_PREFIX}:cancel:` }]);
  return { inline_keyboard: rows };
}

export async function onPersonaCommand(deps: CommandDeps, cmd: CommandCtx): Promise<void> {
  const presets = butler.listPersonaPresets();
  if (presets.length === 0) {
    await deps.sendMessage(cmd.chatId, "No persona presets found.");
    return;
  }
  const active = butler.getActivePersona();
  const current = active.base ?? active.name;
  deps.sessions.set(cmd.chatId, cmd.userId, PERSONA_PREFIX, { step: "pick" });
  await deps.sendMessage(
    cmd.chatId,
    `Persona — current: ${active.name}${active.base ? ` (base: ${active.base})` : ""}`,
    { reply_markup: personaKeyboard(presets, current) },
  );
}

export async function onPersonaCallback(
  deps: CommandDeps,
  parsed: ParsedCallback,
  ctx: CallbackCtx,
): Promise<void> {
  if (parsed.action === "cancel") {
    deps.sessions.clear(ctx.chatId, ctx.userId, PERSONA_PREFIX);
    await ctx.editText("Cancelled.");
    await ctx.answer();
    return;
  }

  if (parsed.action === "set") {
    const session = deps.sessions.get(ctx.chatId, ctx.userId, PERSONA_PREFIX);
    if (!session) {
      await ctx.answer("This menu expired. Run /persona again.", { showAlert: true });
      return;
    }
    const name = parsed.payload;
    if (!butler.listPersonaPresets().includes(name)) {
      await ctx.answer(`Unknown preset: ${name}`);
      return;
    }
    try {
      butler.setPersona(name);
    } catch (e) {
      await ctx.answer(`Failed: ${(e as Error).message}`, { showAlert: true });
      return;
    }
    deps.sessions.clear(ctx.chatId, ctx.userId, PERSONA_PREFIX);
    await ctx.editText(`Persona set to ${name}. (Takes effect on next butler session.)`);
    await ctx.answer(`✅ ${name}`);
    return;
  }

  await ctx.answer(`Unknown action: ${parsed.action}`);
}

// ─── /status ────────────────────────────────────────────────────────────────

export async function onStatusCommand(deps: CommandDeps, cmd: CommandCtx): Promise<void> {
  const snap = butler.getSystemSnapshot();
  const scheduleLine = snap.cronsRegistered === 0
    ? "Crons: 0 registered"
    : snap.nextCron
      ? `Crons: ${snap.cronsRegistered} registered / Next: ${snap.nextCron.name} (${snap.nextCron.schedule})`
      : `Crons: ${snap.cronsRegistered} registered`;
  const headerLines = [
    `Butler with you for ${snap.installedFor}`,
    `Model: butler=${snap.butlerModel} worker=${snap.workerModel}`,
    "",
    `Uptime: ${snap.uptime}`,
    `Tasks: ${snap.tasksTotal} total (${snap.tasksRunning} running, ${snap.tasksDone} done, ${snap.tasksFailed} failed)`,
    `Projects: ${snap.projectsCount}`,
    `Last session sync: ${snap.lastSessionSync ?? "never"}`,
    `Hot cache: ${snap.hotCacheFiles} files`,
    "",
    "— Schedule —",
    scheduleLine,
  ];
  const header = headerLines.join("\n");

  const butlerHome = butler.butlerHome();
  let contextOutput: string;
  try {
    const bunBin = process.env.BUTLER_BUN || `${butler.butlerData()}/runtime/bun/current/bin/bun`;
    contextOutput = execSync(`"${bunBin}" run "${butlerHome}/packages/butler-agent/scripts/status-context.ts"`, {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, BUTLER_BUN: bunBin },
    }).trim();
  } catch (err: unknown) {
    contextOutput = `context unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }

  const dashboard = renderWorkDashboard(createWorkDashboard({
    butlerData: butler.butlerData(),
    limit: 5,
    debug: false,
  }));
  const body = contextOutput ? `${header}\n\n${dashboard}\n\n${contextOutput}` : `${header}\n\n${dashboard}`;
  await deps.sendMessage(cmd.chatId, "```\n" + body + "\n```", { parse_mode: "MarkdownV2" });
}

// ─── /help ──────────────────────────────────────────────────────────────────

export async function onHelpCommand(deps: CommandDeps, cmd: CommandCtx): Promise<void> {
  const text = [
    "Butler commands:",
    "",
    "/model — switch worker or butler model",
    "/persona — switch persona preset",
    "/status — system status snapshot",
    "/tasks — list recent tasks, cancel any",
    "/restart — restart butler (confirm required)",
    "/project — list registered projects",
    "/kill — pick a running task to kill",
    "/help — this help",
  ].join("\n");
  await deps.sendMessage(cmd.chatId, text);
}

// ─── /tasks ─────────────────────────────────────────────────────────────────
// Each row is one button labelled "[STATUS] project — request…", tapping cancels.

export const TASKS_PREFIX = "tasks";
const TASKS_MAX_ROWS = 10;

function tasksKeyboard(rows: butler.TaskRow[]): InlineKeyboardMarkup {
  const buttons: InlineButton[][] = rows.slice(0, TASKS_MAX_ROWS).map(r => {
    const label = `[${r.status}] ${r.project || "?"} — ${r.request.slice(0, 40)}`;
    return [{ text: label, callback_data: `${TASKS_PREFIX}:pick:${r.taskId}` }];
  });
  buttons.push([{ text: "✖ Close", callback_data: `${TASKS_PREFIX}:cancel:` }]);
  return { inline_keyboard: buttons };
}

export async function onTasksCommand(deps: CommandDeps, cmd: CommandCtx): Promise<void> {
  const rows = butler.listTaskRows();
  if (rows.length === 0) {
    await deps.sendMessage(cmd.chatId, "No tasks.");
    return;
  }
  deps.sessions.set(cmd.chatId, cmd.userId, TASKS_PREFIX, { step: "list" });
  await deps.sendMessage(
    cmd.chatId,
    `Recent tasks (${Math.min(rows.length, TASKS_MAX_ROWS)} of ${rows.length}) — tap to cancel:`,
    { reply_markup: tasksKeyboard(rows) },
  );
}

export async function onTasksCallback(
  deps: CommandDeps,
  parsed: ParsedCallback,
  ctx: CallbackCtx,
): Promise<void> {
  if (parsed.action === "cancel") {
    deps.sessions.clear(ctx.chatId, ctx.userId, TASKS_PREFIX);
    await ctx.editText("Closed.");
    await ctx.answer();
    return;
  }

  if (parsed.action === "pick") {
    const session = deps.sessions.get(ctx.chatId, ctx.userId, TASKS_PREFIX);
    if (!session) {
      await ctx.answer("This menu expired. Run /tasks again.", { showAlert: true });
      return;
    }
    const taskId = parsed.payload;
    const res = await butler.killTask(taskId);
    if (!res.ok) {
      await ctx.answer(res.msg, { showAlert: true });
      return;
    }
    await ctx.answer(`✅ cancelled ${taskId}`);
    // Refresh list in-place.
    const rows = butler.listTaskRows();
    await ctx.editText(`Cancelled ${taskId}. Refreshed list:`, { reply_markup: tasksKeyboard(rows) });
    return;
  }

  await ctx.answer(`Unknown action: ${parsed.action}`);
}

// ─── /restart ───────────────────────────────────────────────────────────────

export const RESTART_PREFIX = "restart";

function restartKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "✅ Yes, restart", callback_data: `${RESTART_PREFIX}:yes:` },
      { text: "✖ No", callback_data: `${RESTART_PREFIX}:no:` },
    ]],
  };
}

export async function onRestartCommand(deps: CommandDeps, cmd: CommandCtx): Promise<void> {
  deps.sessions.set(cmd.chatId, cmd.userId, RESTART_PREFIX, { step: "confirm" });
  await deps.sendMessage(cmd.chatId, "Restart butler?", { reply_markup: restartKeyboard() });
}

export async function onRestartCallback(
  deps: CommandDeps,
  parsed: ParsedCallback,
  ctx: CallbackCtx,
): Promise<void> {
  if (parsed.action === "no") {
    deps.sessions.clear(ctx.chatId, ctx.userId, RESTART_PREFIX);
    await ctx.editText("Restart cancelled.");
    await ctx.answer();
    return;
  }
  if (parsed.action === "yes") {
    const session = deps.sessions.get(ctx.chatId, ctx.userId, RESTART_PREFIX);
    if (!session) {
      await ctx.answer("This menu expired. Run /restart again.", { showAlert: true });
      return;
    }
    deps.sessions.clear(ctx.chatId, ctx.userId, RESTART_PREFIX);
    try {
      await butler.runRestart();
    } catch (e) {
      await ctx.editText(`Restart failed: ${(e as Error).message}`);
      await ctx.answer("failed", { showAlert: true });
      return;
    }
    await ctx.editText("Restart triggered. Butler is coming back up.");
    await ctx.answer("🔄 restarting");
    return;
  }
  await ctx.answer(`Unknown action: ${parsed.action}`);
}

// ─── /project ───────────────────────────────────────────────────────────────

export const PROJECT_PREFIX = "project";

function projectsKeyboard(list: butler.ProjectEntry[]): InlineKeyboardMarkup {
  const rows: InlineButton[][] = list.map(p => [{
    text: p.name,
    callback_data: `${PROJECT_PREFIX}:select:${p.name}`,
  }]);
  rows.push([{ text: "✖ Close", callback_data: `${PROJECT_PREFIX}:cancel:` }]);
  return { inline_keyboard: rows };
}

export async function onProjectCommand(deps: CommandDeps, cmd: CommandCtx): Promise<void> {
  const list = butler.listProjectsFromConfig();
  if (list.length === 0) {
    await deps.sendMessage(cmd.chatId, "No projects registered.");
    return;
  }
  deps.sessions.set(cmd.chatId, cmd.userId, PROJECT_PREFIX, { step: "list" });
  await deps.sendMessage(cmd.chatId, `Projects (${list.length}):`, { reply_markup: projectsKeyboard(list) });
}

export async function onProjectCallback(
  deps: CommandDeps,
  parsed: ParsedCallback,
  ctx: CallbackCtx,
): Promise<void> {
  if (parsed.action === "cancel") {
    deps.sessions.clear(ctx.chatId, ctx.userId, PROJECT_PREFIX);
    await ctx.editText("Closed.");
    await ctx.answer();
    return;
  }
  if (parsed.action === "select") {
    const session = deps.sessions.get(ctx.chatId, ctx.userId, PROJECT_PREFIX);
    if (!session) {
      await ctx.answer("This menu expired. Run /project again.", { showAlert: true });
      return;
    }
    const list = butler.listProjectsFromConfig();
    const p = list.find(x => x.name === parsed.payload);
    if (!p) {
      await ctx.answer("Unknown project.");
      return;
    }
    deps.sessions.clear(ctx.chatId, ctx.userId, PROJECT_PREFIX);
    const lines = [`${p.name}`, `path: ${p.path}`];
    if (p.description) lines.push(`desc: ${p.description}`);
    await ctx.editText(lines.join("\n"));
    await ctx.answer();
    return;
  }
  await ctx.answer(`Unknown action: ${parsed.action}`);
}

// ─── /kill ──────────────────────────────────────────────────────────────────
// Pick from running tasks → confirm → kill. Two steps, two session states.

export const KILL_PREFIX = "kill";

function killPickKeyboard(rows: butler.TaskRow[]): InlineKeyboardMarkup {
  const buttons: InlineButton[][] = rows.slice(0, TASKS_MAX_ROWS).map(r => {
    const label = `[${r.status}] ${r.project || "?"} — ${r.request.slice(0, 40)}`;
    return [{ text: label, callback_data: `${KILL_PREFIX}:pick:${r.taskId}` }];
  });
  buttons.push([{ text: "✖ Cancel", callback_data: `${KILL_PREFIX}:cancel:` }]);
  return { inline_keyboard: buttons };
}

function killConfirmKeyboard(taskId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "✅ Confirm kill", callback_data: `${KILL_PREFIX}:confirm:${taskId}` },
      { text: "✖ Cancel", callback_data: `${KILL_PREFIX}:cancel:` },
    ]],
  };
}

export async function onKillCommand(deps: CommandDeps, cmd: CommandCtx): Promise<void> {
  const rows = butler.listRunningTasks();
  if (rows.length === 0) {
    await deps.sendMessage(cmd.chatId, "No running tasks.");
    return;
  }
  deps.sessions.set(cmd.chatId, cmd.userId, KILL_PREFIX, { step: "pick" });
  await deps.sendMessage(cmd.chatId, `Running tasks (${rows.length}) — pick one to kill:`, {
    reply_markup: killPickKeyboard(rows),
  });
}

export async function onKillCallback(
  deps: CommandDeps,
  parsed: ParsedCallback,
  ctx: CallbackCtx,
): Promise<void> {
  if (parsed.action === "cancel") {
    deps.sessions.clear(ctx.chatId, ctx.userId, KILL_PREFIX);
    await ctx.editText("Cancelled.");
    await ctx.answer();
    return;
  }

  if (parsed.action === "pick") {
    const session = deps.sessions.get(ctx.chatId, ctx.userId, KILL_PREFIX);
    if (!session || (session as { step?: string }).step !== "pick") {
      await ctx.answer("This menu expired. Run /kill again.", { showAlert: true });
      return;
    }
    const taskId = parsed.payload;
    deps.sessions.set(ctx.chatId, ctx.userId, KILL_PREFIX, { step: "confirm", taskId });
    await ctx.editText(`Kill ${taskId}? This sends SIGTERM to the whole process group.`, {
      reply_markup: killConfirmKeyboard(taskId),
    });
    await ctx.answer();
    return;
  }

  if (parsed.action === "confirm") {
    const session = deps.sessions.get(ctx.chatId, ctx.userId, KILL_PREFIX) as { step?: string; taskId?: string } | null;
    if (!session || session.step !== "confirm" || session.taskId !== parsed.payload) {
      await ctx.answer("This menu expired. Run /kill again.", { showAlert: true });
      return;
    }
    deps.sessions.clear(ctx.chatId, ctx.userId, KILL_PREFIX);
    const res = await butler.killTask(parsed.payload);
    if (!res.ok) {
      await ctx.editText(`Kill failed: ${res.msg}`);
      await ctx.answer("failed", { showAlert: true });
      return;
    }
    await ctx.editText(`Killed ${parsed.payload}. (${res.msg})`);
    await ctx.answer("✅ killed");
    return;
  }

  await ctx.answer(`Unknown action: ${parsed.action}`);
}
