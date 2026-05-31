// Context-aware /project command — extends the old read-only listing with
// attach / detach / switch / info flows when invoked inside a forum topic.
//
// State machine and UX follow the historical topic-project-unification plan B.5.3.

import { existsSync, readdirSync, statSync } from "fs";
import { isAbsolute, resolve as resolvePath, join } from "path";
import { homedir } from "os";
import type { CallbackCtx, ParsedCallback } from "./router.ts";
import type { InlineKeyboardMarkup, InlineButton, CommandDeps } from "./handlers.ts";
import { STRINGS, format } from "./strings.ko.ts";
import { resolveTopicConfig } from "./defaults.ts";
import { assertCallbackLen } from "./topic-util.ts";
import {
  readTopic, updateTopic, readTopics, pushRecentlyAttached,
  ensureTopicDir, topicDirPath, readDiscoveryRoots, readTopicConfig,
  type TopicEntry,
} from "./topic-store.ts";
import * as butler from "./butler.ts";

export const PROJECT_PREFIX = "project";

export type ProjectDeps = CommandDeps & {
  schedule: (fn: () => void | Promise<void>, delayMs: number) => void
  now?: () => number
};

export type ProjectCmdCtx = {
  chatId: string
  userId: string
  threadId: number | null
};

const CB = {
  rootAttach: `${PROJECT_PREFIX}:root:attach`,
  rootSwitch: `${PROJECT_PREFIX}:root:switch`,
  rootDetach: `${PROJECT_PREFIX}:root:detach`,
  rootInfo: `${PROJECT_PREFIX}:root:info`,
  rootList: `${PROJECT_PREFIX}:root:list`,
  pick: (idx: number) => `${PROJECT_PREFIX}:pick:${idx}`,
  pickManual: `${PROJECT_PREFIX}:pick:manual`,
  attachConfirm: `${PROJECT_PREFIX}:aconfirm:`,
  detachConfirm: `${PROJECT_PREFIX}:dconfirm:`,
  undoDetach: `${PROJECT_PREFIX}:undo:detach`,
  cancel: `${PROJECT_PREFIX}:cancel:`,
};

// ── candidate discovery ──────────────────────────────────────────────────────
// Candidates = config.projects[] ∪ discoveryRoots/* (dirs) minus anything
// whose path doesn't exist. Dedup by path.

type Candidate = { name: string; path: string; source: "config" | "discovery" };

function expandTilde(p: string): string {
  return p.startsWith("~") ? p.replace(/^~/, homedir()) : p;
}

export function discoverProjects(): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const p of butler.listProjectsFromConfig()) {
    const path = expandTilde(p.path);
    if (!seen.has(path)) seen.set(path, { name: p.name, path, source: "config" });
  }
  for (const root of readDiscoveryRoots()) {
    const dir = expandTilde(root);
    try {
      for (const name of readdirSync(dir)) {
        if (name.startsWith(".")) continue;
        const abs = join(dir, name);
        try {
          if (!statSync(abs).isDirectory()) continue;
        } catch { continue; }
        if (!seen.has(abs)) seen.set(abs, { name, path: abs, source: "discovery" });
      }
    } catch {}
  }
  return [...seen.values()];
}

// Order candidates with the topic's recently-attached projects pinned at top
// (⭐), then config entries, then discovery entries — each block alphabetical.
export function orderedCandidates(
  candidates: Candidate[],
  lastAttached: string[] | undefined,
): Array<Candidate & { pinned: boolean }> {
  const pinnedNames = (lastAttached ?? []).filter(n => candidates.some(c => c.name === n));
  const pinned = pinnedNames
    .map(n => candidates.find(c => c.name === n))
    .filter((c): c is Candidate => !!c)
    .map(c => ({ ...c, pinned: true }));
  const rest = candidates
    .filter(c => !pinnedNames.includes(c.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => ({ ...c, pinned: false }));
  return [...pinned, ...rest];
}

// ── keyboards ────────────────────────────────────────────────────────────────

function renderKeyboard(rows: InlineButton[][]): InlineKeyboardMarkup {
  for (const row of rows) for (const b of row) assertCallbackLen(b.callback_data);
  return { inline_keyboard: rows };
}

function rootKeyboardAttached(): InlineKeyboardMarkup {
  return renderKeyboard([
    [{ text: STRINGS.project.root_switch, callback_data: CB.rootSwitch }],
    [{ text: STRINGS.project.root_detach, callback_data: CB.rootDetach }],
    [{ text: STRINGS.project.root_info, callback_data: CB.rootInfo }],
    [{ text: STRINGS.project.root_list, callback_data: CB.rootList }],
    [{ text: `✖ ${STRINGS.common.cancel}`, callback_data: CB.cancel }],
  ]);
}

function rootKeyboardDetached(): InlineKeyboardMarkup {
  return renderKeyboard([
    [{ text: STRINGS.project.root_attach, callback_data: CB.rootAttach }],
    [{ text: STRINGS.project.root_list, callback_data: CB.rootList }],
    [{ text: `✖ ${STRINGS.common.cancel}`, callback_data: CB.cancel }],
  ]);
}

function rootKeyboardNoTopic(): InlineKeyboardMarkup {
  return renderKeyboard([
    [{ text: STRINGS.project.root_list, callback_data: CB.rootList }],
    [{ text: `✖ ${STRINGS.common.cancel}`, callback_data: CB.cancel }],
  ]);
}

function pickerKeyboard(
  cands: Array<Candidate & { pinned: boolean }>,
  includeManual: boolean,
): InlineKeyboardMarkup {
  const rows: InlineButton[][] = cands.map((c, i) => [{
    text: c.pinned ? `⭐ ${c.name}` : c.name,
    callback_data: CB.pick(i),
  }]);
  if (includeManual) {
    rows.push([{ text: STRINGS.project.attach.manual, callback_data: CB.pickManual }]);
  }
  rows.push([{ text: `✖ ${STRINGS.common.cancel}`, callback_data: CB.cancel }]);
  return renderKeyboard(rows);
}

function attachConfirmKeyboard(): InlineKeyboardMarkup {
  return renderKeyboard([[
    { text: `✅ ${STRINGS.common.confirm}`, callback_data: CB.attachConfirm },
    { text: `✖ ${STRINGS.common.cancel}`, callback_data: CB.cancel },
  ]]);
}

function detachConfirmKeyboard(): InlineKeyboardMarkup {
  return renderKeyboard([[
    { text: `✅ ${STRINGS.common.confirm}`, callback_data: CB.detachConfirm },
    { text: `✖ ${STRINGS.common.cancel}`, callback_data: CB.cancel },
  ]]);
}

function undoAfterDetachKeyboard(): InlineKeyboardMarkup {
  return renderKeyboard([[
    { text: `↩ ${STRINGS.common.undo}`, callback_data: CB.undoDetach },
  ]]);
}

// ── slash entry ──────────────────────────────────────────────────────────────

export async function onProjectCommand(deps: ProjectDeps, cmd: ProjectCmdCtx): Promise<void> {
  if (cmd.threadId == null) {
    const list = butler.listProjectsFromConfig();
    if (list.length === 0) {
      await deps.sendMessage(cmd.chatId, STRINGS.project.empty_state_no_topic);
      return;
    }
    deps.sessions.set(cmd.chatId, cmd.userId, PROJECT_PREFIX, {
      step: "list-only",
    });
    await deps.sendMessage(
      cmd.chatId,
      STRINGS.project.empty_state_no_topic,
      { reply_markup: rootKeyboardNoTopic() },
    );
    return;
  }
  const entry = readTopic(cmd.threadId);
  const attached = !!entry?.project;
  const header = attached
    ? format(STRINGS.project.header_attached, { name: entry!.project! })
    : STRINGS.project.header_detached;
  deps.sessions.set(cmd.chatId, cmd.userId, PROJECT_PREFIX, {
    step: "root",
    threadId: cmd.threadId,
    attached,
  });
  await deps.sendMessage(cmd.chatId, header, {
    reply_markup: attached ? rootKeyboardAttached() : rootKeyboardDetached(),
  });
}

// ── callback router ──────────────────────────────────────────────────────────

export async function onProjectCallback(
  deps: ProjectDeps,
  parsed: ParsedCallback,
  ctx: CallbackCtx,
): Promise<void> {
  if (parsed.action === "cancel") {
    deps.sessions.clear(ctx.chatId, ctx.userId, PROJECT_PREFIX);
    await ctx.editText(STRINGS.common.cancel);
    await ctx.answer();
    return;
  }

  const session = deps.sessions.get(ctx.chatId, ctx.userId, PROJECT_PREFIX) as Record<string, any> | null;
  if (!session) {
    await ctx.answer(STRINGS.common.menu_expired, { showAlert: true });
    return;
  }

  switch (parsed.action) {
    case "root":
      return routeRoot(deps, ctx, session, parsed.payload);
    case "pick":
      return routePick(deps, ctx, session, parsed.payload);
    case "aconfirm":
      return routeAttachConfirm(deps, ctx, session);
    case "dconfirm":
      return routeDetachConfirm(deps, ctx, session);
    case "undo":
      return routeUndo(deps, ctx, session, parsed.payload);
    default:
      await ctx.answer(format(STRINGS.common.unknown_action, { action: parsed.action }));
  }
}

async function routeRoot(
  deps: ProjectDeps,
  ctx: CallbackCtx,
  session: Record<string, any>,
  payload: string,
): Promise<void> {
  if (payload === "list") {
    await ctx.editText(renderList());
    await ctx.answer();
    deps.sessions.clear(ctx.chatId, ctx.userId, PROJECT_PREFIX);
    return;
  }
  if (payload === "info") {
    const entry = session.threadId != null ? readTopic(Number(session.threadId)) : null;
    if (!entry?.project) {
      await ctx.answer(STRINGS.project.empty_state_no_topic);
      return;
    }
    await ctx.editText(renderInfo(entry));
    await ctx.answer();
    deps.sessions.clear(ctx.chatId, ctx.userId, PROJECT_PREFIX);
    return;
  }
  if (payload === "attach" || payload === "switch") {
    const tid = Number(session.threadId);
    if (!Number.isFinite(tid)) {
      await ctx.answer(STRINGS.common.menu_expired, { showAlert: true });
      return;
    }
    const entry = readTopic(tid);
    const cands = discoverProjects().filter(c => !entry?.project || c.name !== entry.project);
    if (cands.length === 0 && !entry) {
      await ctx.editText(STRINGS.project.attach.manual_prompt.replace("{ttl}",
        String(resolveTopicConfig(readTopicConfig()).awaitInputTtlSec)));
      deps.sessions.set(ctx.chatId, ctx.userId, PROJECT_PREFIX, {
        ...session, step: "await-manual-path",
      });
      await ctx.answer();
      return;
    }
    const ordered = orderedCandidates(cands, entry?.lastAttachedProjects);
    deps.sessions.set(ctx.chatId, ctx.userId, PROJECT_PREFIX, {
      ...session,
      step: "picker",
      mode: payload,
      candidatesSnapshot: ordered.map(c => ({ name: c.name, path: c.path })),
      prevProject: entry?.project ?? null,
    });
    await ctx.editText(STRINGS.project.attach.picker_title, {
      reply_markup: pickerKeyboard(ordered, true),
    });
    await ctx.answer();
    return;
  }
  if (payload === "detach") {
    const tid = Number(session.threadId);
    const entry = tid ? readTopic(tid) : null;
    if (!entry?.project) {
      await ctx.answer(STRINGS.project.empty_state_no_topic);
      return;
    }
    deps.sessions.set(ctx.chatId, ctx.userId, PROJECT_PREFIX, {
      ...session,
      step: "detach-confirm",
      prevProject: entry.project,
      prevPath: entry.path,
    });
    const cwd = topicDirPath(tid, entry.slug);
    await ctx.editText(format(STRINGS.project.detach.confirm, { cwd }), {
      reply_markup: detachConfirmKeyboard(),
    });
    await ctx.answer();
    return;
  }
  await ctx.answer(format(STRINGS.common.unknown_action, { action: `root:${payload}` }));
}

async function routePick(
  deps: ProjectDeps,
  ctx: CallbackCtx,
  session: Record<string, any>,
  payload: string,
): Promise<void> {
  if (payload === "manual") {
    const ttl = resolveTopicConfig(readTopicConfig()).awaitInputTtlSec;
    deps.sessions.set(ctx.chatId, ctx.userId, PROJECT_PREFIX, { ...session, step: "await-manual-path" });
    await ctx.editText(format(STRINGS.project.attach.manual_prompt, { ttl }));
    await ctx.answer();
    return;
  }
  const idx = Number(payload);
  const snap = session.candidatesSnapshot as Array<{ name: string; path: string }> | undefined;
  if (!snap || !Number.isInteger(idx) || idx < 0 || idx >= snap.length) {
    await ctx.answer(STRINGS.common.menu_expired, { showAlert: true });
    return;
  }
  const pick = snap[idx]!;
  const tid = Number(session.threadId);
  const entry = readTopic(tid);
  deps.sessions.set(ctx.chatId, ctx.userId, PROJECT_PREFIX, {
    ...session,
    step: "attach-confirm",
    pickName: pick.name,
    pickPath: pick.path,
  });
  await ctx.editText(
    format(STRINGS.project.attach.confirm, {
      topic: entry?.topicName ?? `t${tid}`,
      project: pick.name,
    }),
    { reply_markup: attachConfirmKeyboard() },
  );
  await ctx.answer();
}

async function routeAttachConfirm(
  deps: ProjectDeps,
  ctx: CallbackCtx,
  session: Record<string, any>,
): Promise<void> {
  const tid = Number(session.threadId);
  const name = session.pickName as string | undefined;
  const path = session.pickPath as string | undefined;
  if (!Number.isFinite(tid) || !name || !path) {
    await ctx.answer(STRINGS.common.menu_expired, { showAlert: true });
    return;
  }
  if (session.inFlight) {
    await ctx.answer(STRINGS.common.in_flight);
    return;
  }
  deps.sessions.set(ctx.chatId, ctx.userId, PROJECT_PREFIX, { ...session, inFlight: true });
  await ctx.editText(STRINGS.common.processing);
  try {
    updateTopic(tid, { project: name, path });
    pushRecentlyAttached(tid, name);
  } catch (e) {
    await ctx.editText(format(STRINGS.project.attach.fail, { reason: (e as Error).message }));
    await ctx.answer();
    deps.sessions.clear(ctx.chatId, ctx.userId, PROJECT_PREFIX);
    return;
  }
  await ctx.editText(STRINGS.project.attach.ok);
  await ctx.answer();
  deps.sessions.clear(ctx.chatId, ctx.userId, PROJECT_PREFIX);
}

async function routeDetachConfirm(
  deps: ProjectDeps,
  ctx: CallbackCtx,
  session: Record<string, any>,
): Promise<void> {
  const tid = Number(session.threadId);
  if (!Number.isFinite(tid)) {
    await ctx.answer(STRINGS.common.menu_expired, { showAlert: true });
    return;
  }
  const entry = readTopic(tid);
  if (!entry?.project) {
    await ctx.answer(STRINGS.project.empty_state_no_topic);
    return;
  }
  if (session.inFlight) {
    await ctx.answer(STRINGS.common.in_flight);
    return;
  }
  deps.sessions.set(ctx.chatId, ctx.userId, PROJECT_PREFIX, { ...session, inFlight: true });
  await ctx.editText(STRINGS.common.processing);
  const prev = { project: entry.project, path: entry.path };
  updateTopic(tid, { project: undefined, path: undefined });
  ensureTopicDir(tid, entry.slug);
  await ctx.editText(STRINGS.project.detach.ok, { reply_markup: undoAfterDetachKeyboard() });
  await ctx.answer();
  deps.sessions.set(ctx.chatId, ctx.userId, PROJECT_PREFIX, {
    step: "detached",
    threadId: tid,
    prevProject: prev.project,
    prevPath: prev.path,
  });
  const topicCfg = resolveTopicConfig(readTopicConfig());
  deps.schedule(async () => {
    const cur = deps.sessions.get(ctx.chatId, ctx.userId, PROJECT_PREFIX) as Record<string, any> | null;
    if (cur?.step === "detached" && Number(cur.threadId) === tid) {
      try { await ctx.editText(STRINGS.project.detach.ok); } catch {}
      deps.sessions.clear(ctx.chatId, ctx.userId, PROJECT_PREFIX);
    }
  }, topicCfg.undoWindowSec * 1000);
}

async function routeUndo(
  deps: ProjectDeps,
  ctx: CallbackCtx,
  session: Record<string, any>,
  payload: string,
): Promise<void> {
  if (payload !== "detach") {
    await ctx.answer();
    return;
  }
  const tid = Number(session.threadId);
  const prevProject = session.prevProject as string | undefined;
  const prevPath = session.prevPath as string | undefined;
  if (!Number.isFinite(tid) || !prevProject) {
    await ctx.answer(STRINGS.common.menu_expired, { showAlert: true });
    return;
  }
  await ctx.editText(STRINGS.common.processing);
  updateTopic(tid, { project: prevProject, path: prevPath });
  await ctx.editText(STRINGS.project.detach.undo_ok);
  await ctx.answer();
  deps.sessions.clear(ctx.chatId, ctx.userId, PROJECT_PREFIX);
}

// ── manual path capture ──────────────────────────────────────────────────────

export async function handleManualPathInput(
  deps: ProjectDeps,
  chatId: string,
  userId: string,
  text: string,
  sendConfirm: (text: string, markup: InlineKeyboardMarkup) => Promise<void>,
): Promise<boolean> {
  const session = deps.sessions.get(chatId, userId, PROJECT_PREFIX) as Record<string, any> | null;
  if (!session || session.step !== "await-manual-path") return false;
  const raw = expandTilde(text.trim());
  // Require absolute path — prevents ambiguous relative paths and obvious
  // traversal ("../../..") that would resolve against process CWD.
  if (!raw || !isAbsolute(raw)) {
    await sendConfirm(STRINGS.project.attach.manual_invalid, rootKeyboardDetached());
    return true;
  }
  const path = resolvePath(raw);
  let okDir: boolean;
  try { okDir = existsSync(path) && statSync(path).isDirectory(); } catch { okDir = false; }
  if (!okDir) {
    await sendConfirm(STRINGS.project.attach.manual_invalid, rootKeyboardDetached());
    return true;
  }
  const name = path.split("/").filter(Boolean).slice(-1)[0] ?? "manual";
  const tid = Number(session.threadId);
  const entry = tid ? readTopic(tid) : null;
  deps.sessions.set(chatId, userId, PROJECT_PREFIX, {
    ...session,
    step: "attach-confirm",
    pickName: name,
    pickPath: path,
  });
  await sendConfirm(
    format(STRINGS.project.attach.confirm, {
      topic: entry?.topicName ?? `t${tid}`,
      project: name,
    }),
    attachConfirmKeyboard(),
  );
  return true;
}

// ── list / info render ───────────────────────────────────────────────────────

function renderList(): string {
  const topics = readTopics();
  const lines: string[] = [STRINGS.project.list.title];
  for (const [tid, e] of Object.entries(topics)) {
    const label = e.archivedAt
      ? STRINGS.project.list.row_archived
      : e.project
        ? format(STRINGS.project.list.row_attached, { name: e.project })
        : STRINGS.project.list.row_detached;
    lines.push(`${tid}  ${e.topicName}  ${label}`);
  }
  if (lines.length === 1) lines.push("(empty)");
  return lines.join("\n");
}

function renderInfo(entry: TopicEntry): string {
  const lines: string[] = [];
  lines.push(format(STRINGS.project.info.line_name, { name: entry.project ?? "—" }));
  const path = entry.path ? expandTilde(entry.path) : "";
  lines.push(format(STRINGS.project.info.line_path, { path: entry.path ?? "—" }));
  if (path && !existsSync(path)) lines.push(STRINGS.project.info.line_path_missing);
  return lines.join("\n");
}
