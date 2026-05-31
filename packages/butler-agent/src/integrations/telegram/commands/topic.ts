// /topic and /topic restore command handlers.
//
// Pure DI surface: no grammy import, all side-effects (forum API calls,
// config writes, fs mutations) flow through `TopicDeps`. Keeps handlers
// unit-testable with a fake ctx.
//
// State machine follows the historical topic-project-unification plan B.5.

import type { CallbackCtx, ParsedCallback } from "./router.ts";
import type { InlineKeyboardMarkup, InlineButton, CommandDeps } from "./handlers.ts";
import { STRINGS, format } from "./strings.ko.ts";
import { resolveTopicConfig } from "./defaults.ts";
import { assertCallbackLen, topicSlug, uniqueSlug } from "./topic-util.ts";
import {
  readTopic, updateTopic, readTopics, listArchivedTopics,
  ensureTopicDir, renameTopicDir, topicDirPath,
  readTopicConfig,
} from "./topic-store.ts";

// ── public prefixes ─────────────────────────────────────────────────────────
export const TOPIC_PREFIX = "topic";
export const TOPIC_RESTORE_PREFIX = "trest";

// ── forum API shape (grammy-agnostic) ───────────────────────────────────────
// Each method takes the chat_id and thread_id explicitly so tests can stub
// without pulling grammy in.
export type ForumApi = {
  editForumTopic: (chatId: string | number, threadId: number, args: { name?: string }) => Promise<unknown>
  closeForumTopic: (chatId: string | number, threadId: number) => Promise<unknown>
  reopenForumTopic: (chatId: string | number, threadId: number) => Promise<unknown>
};

export type TopicDeps = CommandDeps & {
  forum: ForumApi
  // Forced memory consolidation before Archive. Throws to abort archive.
  // Optional: when absent (e.g. tests that don't care), archive proceeds.
  consolidateTopic?: (tid: number, slug: string, windowName?: string) => Promise<void>
  // Scheduler for undo expiry. Tests pass a fake that fires immediately or
  // under a fake clock.
  schedule: (fn: () => void | Promise<void>, delayMs: number) => void
  now?: () => number
  log?: (msg: string) => void
};

// ── context passed into slash-command / callback entry points ────────────────
export type TopicCmdCtx = {
  chatId: string
  userId: string
  threadId: number | null
  topicNameHint?: string
};

// ── callback payloads ────────────────────────────────────────────────────────
// Keep ASCII-only, no tid needed (session carries it). All emitted callback
// strings are byte-checked at render time via assertCallbackLen().
const CB = {
  rootRename: `${TOPIC_PREFIX}:root:rename`,
  rootArchive: `${TOPIC_PREFIX}:root:archive`,
  rootInfo: `${TOPIC_PREFIX}:root:info`,
  archGo: `${TOPIC_PREFIX}:arch:go`,
  undoArchive: `${TOPIC_PREFIX}:undo:archive`,
  renameConfirm: `${TOPIC_PREFIX}:rnm:ok`,
  cancel: `${TOPIC_PREFIX}:cancel:`,
};

const RESTORE_CB = {
  pick: (tid: string) => `${TOPIC_RESTORE_PREFIX}:pick:${tid}`,
  cancel: `${TOPIC_RESTORE_PREFIX}:cancel:`,
};

// ── keyboards ────────────────────────────────────────────────────────────────

function renderKeyboard(rows: InlineButton[][]): InlineKeyboardMarkup {
  for (const row of rows) for (const b of row) assertCallbackLen(b.callback_data);
  return { inline_keyboard: rows };
}

function rootKeyboard(): InlineKeyboardMarkup {
  return renderKeyboard([
    [{ text: STRINGS.topic.root_rename, callback_data: CB.rootRename }],
    [{ text: STRINGS.topic.root_archive, callback_data: CB.rootArchive }],
    [{ text: STRINGS.topic.root_info, callback_data: CB.rootInfo }],
    [{ text: `✖ ${STRINGS.common.cancel}`, callback_data: CB.cancel }],
  ]);
}

function undoAfterArchive(): InlineKeyboardMarkup {
  return renderKeyboard([[
    { text: `↩ ${STRINGS.common.undo}`, callback_data: CB.undoArchive },
  ]]);
}

function renameConfirmKeyboard(): InlineKeyboardMarkup {
  return renderKeyboard([[
    { text: `✅ ${STRINGS.common.confirm}`, callback_data: CB.renameConfirm },
    { text: `✖ ${STRINGS.common.cancel}`, callback_data: CB.cancel },
  ]]);
}

function archiveConfirmKeyboard(): InlineKeyboardMarkup {
  return renderKeyboard([[
    { text: STRINGS.topic.archive.confirm_button, callback_data: CB.archGo },
    { text: `✖ ${STRINGS.common.cancel}`, callback_data: CB.cancel },
  ]]);
}

// ── /topic slash entry ───────────────────────────────────────────────────────

export async function onTopicCommand(deps: TopicDeps, cmd: TopicCmdCtx): Promise<void> {
  if (cmd.threadId == null) {
    await deps.sendMessage(cmd.chatId, STRINGS.topic.empty_state);
    return;
  }
  const entry = readTopic(cmd.threadId);
  const name = entry?.topicName ?? cmd.topicNameHint ?? `t${cmd.threadId}`;
  deps.sessions.set(cmd.chatId, cmd.userId, TOPIC_PREFIX, {
    step: "root",
    threadId: cmd.threadId,
  });
  await deps.sendMessage(
    cmd.chatId,
    format(STRINGS.topic.root_title, { name }),
    { reply_markup: rootKeyboard() },
  );
}

// ── /topic restore slash entry ───────────────────────────────────────────────

export async function onTopicRestoreCommand(deps: TopicDeps, cmd: TopicCmdCtx): Promise<void> {
  const archived = listArchivedTopics();
  if (archived.length === 0) {
    await deps.sendMessage(cmd.chatId, STRINGS.topic.restore.empty);
    return;
  }
  deps.sessions.set(cmd.chatId, cmd.userId, TOPIC_RESTORE_PREFIX, { step: "pick" });
  const rows: InlineButton[][] = archived.map(t => [{
    text: `📦 ${t.topicName}`,
    callback_data: RESTORE_CB.pick(t.tid),
  }]);
  rows.push([{ text: `✖ ${STRINGS.common.cancel}`, callback_data: RESTORE_CB.cancel }]);
  await deps.sendMessage(
    cmd.chatId,
    STRINGS.topic.restore.picker_title,
    { reply_markup: renderKeyboard(rows) },
  );
}

// ── callback helpers ─────────────────────────────────────────────────────────

async function withLock(
  deps: TopicDeps,
  ctx: CallbackCtx,
  prefix: string,
  fn: () => Promise<void>,
): Promise<void> {
  const session = deps.sessions.get(ctx.chatId, ctx.userId, prefix) as Record<string, any> | null;
  if (session && session.inFlight) {
    await ctx.answer(STRINGS.common.in_flight);
    return;
  }
  if (session) {
    deps.sessions.set(ctx.chatId, ctx.userId, prefix, { ...session, inFlight: true });
  }
  try {
    await fn();
  } finally {
    const cur = deps.sessions.get(ctx.chatId, ctx.userId, prefix) as Record<string, any> | null;
    if (cur && cur.inFlight) {
      const { inFlight: _drop, ...rest } = cur;
      deps.sessions.set(ctx.chatId, ctx.userId, prefix, rest);
    }
  }
}

// ── /topic callback router ───────────────────────────────────────────────────

export async function onTopicCallback(
  deps: TopicDeps,
  parsed: ParsedCallback,
  ctx: CallbackCtx,
): Promise<void> {
  if (parsed.action === "cancel") {
    deps.sessions.clear(ctx.chatId, ctx.userId, TOPIC_PREFIX);
    await ctx.editText(STRINGS.common.cancel);
    await ctx.answer();
    return;
  }

  const session = deps.sessions.get(ctx.chatId, ctx.userId, TOPIC_PREFIX) as Record<string, any> | null;
  if (!session) {
    await ctx.answer(STRINGS.common.menu_expired, { showAlert: true });
    return;
  }
  const tid = Number(session.threadId);
  if (!Number.isFinite(tid)) {
    await ctx.answer(STRINGS.common.menu_expired, { showAlert: true });
    return;
  }

  switch (parsed.action) {
    case "root":
      return routeRoot(deps, ctx, tid, parsed.payload);
    case "arch":
      return routeArchive(deps, ctx, tid, parsed.payload);
    case "undo":
      return routeUndo(deps, ctx, tid, parsed.payload);
    case "rnm":
      return routeRenameConfirm(deps, ctx, tid);
    default:
      await ctx.answer(format(STRINGS.common.unknown_action, { action: parsed.action }));
  }
}

async function routeRoot(
  deps: TopicDeps,
  ctx: CallbackCtx,
  tid: number,
  payload: string,
): Promise<void> {
  if (payload === "rename") {
    const topicCfg = resolveTopicConfig(readTopicConfig());
    deps.sessions.set(ctx.chatId, ctx.userId, TOPIC_PREFIX, {
      step: "await-name",
      threadId: tid,
      expiresAt: (deps.now?.() ?? Date.now()) + topicCfg.awaitInputTtlSec * 1000,
    });
    await ctx.editText(format(STRINGS.topic.rename.prompt, { ttl: topicCfg.awaitInputTtlSec }));
    await ctx.answer();
    return;
  }
  if (payload === "archive") {
    deps.sessions.set(ctx.chatId, ctx.userId, TOPIC_PREFIX, {
      step: "archive-confirm",
      threadId: tid,
    });
    await ctx.editText(STRINGS.topic.archive.confirm, { reply_markup: archiveConfirmKeyboard() });
    await ctx.answer();
    return;
  }
  if (payload === "info") {
    await ctx.editText(renderInfo(tid));
    await ctx.answer();
    deps.sessions.clear(ctx.chatId, ctx.userId, TOPIC_PREFIX);
    return;
  }
  await ctx.answer(format(STRINGS.common.unknown_action, { action: `root:${payload}` }));
}

async function routeArchive(
  deps: TopicDeps,
  ctx: CallbackCtx,
  tid: number,
  payload: string,
): Promise<void> {
  if (payload !== "go") {
    await ctx.answer(format(STRINGS.common.unknown_action, { action: `arch:${payload}` }));
    return;
  }
  await withLock(deps, ctx, TOPIC_PREFIX, async () => {
    const session = deps.sessions.get(ctx.chatId, ctx.userId, TOPIC_PREFIX) as Record<string, any> | null;
    if (session?.step !== "archive-confirm") {
      await ctx.answer(STRINGS.common.menu_expired, { showAlert: true });
      return;
    }
    const entry = readTopic(tid);
    const windowName = entry?.project ?? (entry ? `t${tid}-${entry.slug}` : `t${tid}`);

    // Step 1 — forced memory consolidation. Failure aborts archive so the
    // principal can retry without losing the chance to consolidate.
    await ctx.editText(STRINGS.topic.archive.consolidating);
    if (deps.consolidateTopic) {
      try {
        await deps.consolidateTopic(tid, entry?.slug ?? String(tid), windowName);
      } catch (e) {
        await ctx.editText(format(STRINGS.topic.archive.consolidate_fail, { reason: (e as Error).message }));
        await ctx.answer();
        deps.sessions.clear(ctx.chatId, ctx.userId, TOPIC_PREFIX);
        return;
      }
    }

    // Step 2 — close the forum topic.
    try {
      await deps.forum.closeForumTopic(ctx.chatId, tid);
    } catch (e) {
      await ctx.editText(format(STRINGS.topic.archive.fail, { reason: (e as Error).message }));
      await ctx.answer();
      deps.sessions.clear(ctx.chatId, ctx.userId, TOPIC_PREFIX);
      return;
    }

    // Step 3 — stamp archivedAt and show undo.
    const nowIso = new Date(deps.now?.() ?? Date.now()).toISOString();
    updateTopic(tid, { archivedAt: nowIso });
    await ctx.editText(STRINGS.topic.archive.ok, { reply_markup: undoAfterArchive() });
    await ctx.answer();
    deps.sessions.set(ctx.chatId, ctx.userId, TOPIC_PREFIX, {
      step: "archived",
      threadId: tid,
    });
    const topicCfg = resolveTopicConfig(readTopicConfig());
    deps.schedule(async () => {
      const cur = deps.sessions.get(ctx.chatId, ctx.userId, TOPIC_PREFIX) as Record<string, any> | null;
      if (cur?.step === "archived") {
        try { await ctx.editText(STRINGS.topic.archive.ok); } catch {}
        deps.sessions.clear(ctx.chatId, ctx.userId, TOPIC_PREFIX);
      }
    }, topicCfg.undoWindowSec * 1000);
  });
}

async function routeUndo(
  deps: TopicDeps,
  ctx: CallbackCtx,
  tid: number,
  payload: string,
): Promise<void> {
  if (payload !== "archive") {
    await ctx.answer();
    return;
  }
  await withLock(deps, ctx, TOPIC_PREFIX, async () => {
    const entry = readTopic(tid);
    if (!entry?.archivedAt) {
      await ctx.answer(STRINGS.common.menu_expired);
      return;
    }
    await ctx.editText(STRINGS.common.processing);
    try {
      await deps.forum.reopenForumTopic(ctx.chatId, tid);
    } catch (e) {
      await ctx.editText(format(STRINGS.topic.archive.fail, { reason: (e as Error).message }));
      await ctx.answer();
      return;
    }
    updateTopic(tid, { archivedAt: undefined });
    await ctx.editText(STRINGS.topic.archive.undo_ok);
    await ctx.answer();
    deps.sessions.clear(ctx.chatId, ctx.userId, TOPIC_PREFIX);
  });
}

async function routeRenameConfirm(
  deps: TopicDeps,
  ctx: CallbackCtx,
  tid: number,
): Promise<void> {
  await withLock(deps, ctx, TOPIC_PREFIX, async () => {
    const session = deps.sessions.get(ctx.chatId, ctx.userId, TOPIC_PREFIX) as Record<string, any> | null;
    const newName = session?.pendingName;
    if (typeof newName !== "string" || !newName.trim()) {
      await ctx.answer(STRINGS.common.menu_expired, { showAlert: true });
      return;
    }
    await ctx.editText(STRINGS.common.processing);
    try {
      await deps.forum.editForumTopic(ctx.chatId, tid, { name: newName });
    } catch (e) {
      await ctx.editText(format(STRINGS.topic.rename.fail, { reason: (e as Error).message }));
      await ctx.answer();
      return;
    }
    const entry = readTopic(tid);
    const prevSlug = entry?.slug;
    // Only rename dir if project unattached.
    let newSlug = prevSlug ?? topicSlug(newName, tid);
    if (entry && !entry.project) {
      const base = topicSlug(newName, tid);
      const taken = Object.values(readTopics())
        .map(t => t.slug)
        .filter(s => s && s !== prevSlug) as string[];
      newSlug = uniqueSlug(base, taken);
      if (prevSlug && prevSlug !== newSlug) {
        try {
          renameTopicDir(tid, prevSlug, newSlug);
        } catch (e) {
          // Dir rename failed — keep old slug so the config still points at a
          // real directory. Telegram topic name is already renamed; that's the
          // user-visible part.
          deps.log?.(`topic rename: dir rename failed, keeping old slug: ${(e as Error).message}`);
          newSlug = prevSlug;
        }
      }
    }
    updateTopic(tid, { topicName: newName, slug: newSlug });
    await ctx.editText(STRINGS.topic.rename.ok);
    await ctx.answer();
    deps.sessions.clear(ctx.chatId, ctx.userId, TOPIC_PREFIX);
  });
}

// ── rename: next-message capture hook ────────────────────────────────────────
// server.ts messageHandler calls this when a plaintext message arrives for a
// chat/user that has a TOPIC_PREFIX session in `await-name` step.
export async function handleRenameInput(
  deps: TopicDeps,
  chatId: string,
  userId: string,
  text: string,
  sendConfirm: (text: string, markup: InlineKeyboardMarkup) => Promise<void>,
): Promise<boolean> {
  const session = deps.sessions.get(chatId, userId, TOPIC_PREFIX) as Record<string, any> | null;
  if (!session || session.step !== "await-name") return false;
  const expiresAt = session.expiresAt;
  const now = deps.now?.() ?? Date.now();
  if (typeof expiresAt === "number" && now > expiresAt) {
    deps.sessions.clear(chatId, userId, TOPIC_PREFIX);
    return false;
  }
  const trimmed = text.trim();
  if (trimmed.length < 1 || trimmed.length > 128) {
    await sendConfirm(STRINGS.topic.rename.invalid, rootKeyboard());
    return true;
  }
  deps.sessions.set(chatId, userId, TOPIC_PREFIX, {
    step: "rename-confirm",
    threadId: session.threadId,
    pendingName: trimmed,
  });
  await sendConfirm(format(STRINGS.topic.rename.confirm, { name: trimmed }), renameConfirmKeyboard());
  return true;
}

// ── /topic restore callback ──────────────────────────────────────────────────

export async function onTopicRestoreCallback(
  deps: TopicDeps,
  parsed: ParsedCallback,
  ctx: CallbackCtx,
): Promise<void> {
  if (parsed.action === "cancel") {
    deps.sessions.clear(ctx.chatId, ctx.userId, TOPIC_RESTORE_PREFIX);
    await ctx.editText(STRINGS.common.cancel);
    await ctx.answer();
    return;
  }
  if (parsed.action !== "pick") {
    await ctx.answer(format(STRINGS.common.unknown_action, { action: parsed.action }));
    return;
  }
  const tid = parsed.payload;
  // Guard against tampered callbacks: tid must be a positive integer string.
  if (!/^\d+$/.test(tid)) {
    await ctx.answer(format(STRINGS.common.unknown_action, { action: `pick:${tid}` }));
    return;
  }
  await withLock(deps, ctx, TOPIC_RESTORE_PREFIX, async () => {
    const entry = readTopic(tid);
    if (!entry?.archivedAt) {
      await ctx.answer(STRINGS.topic.restore.empty, { showAlert: true });
      return;
    }
    await ctx.editText(STRINGS.common.processing);
    try {
      await deps.forum.reopenForumTopic(ctx.chatId, Number(tid));
    } catch (e) {
      await ctx.editText(format(STRINGS.topic.restore.fail, { reason: (e as Error).message }));
      await ctx.answer();
      return;
    }
    updateTopic(tid, { archivedAt: undefined });
    await ctx.editText(STRINGS.topic.restore.ok);
    await ctx.answer();
    deps.sessions.clear(ctx.chatId, ctx.userId, TOPIC_RESTORE_PREFIX);
  });
}

// ── info render ──────────────────────────────────────────────────────────────

function renderInfo(tid: number): string {
  const entry = readTopic(tid);
  if (!entry) return format(STRINGS.common.unknown_action, { action: `tid:${tid}` });
  const lines: string[] = [STRINGS.topic.info.title];
  lines.push(format(STRINGS.topic.info.line_thread, { tid }));
  lines.push(format(STRINGS.topic.info.line_name, { name: entry.topicName }));
  lines.push(format(STRINGS.topic.info.line_slug, { slug: entry.slug }));
  if (entry.project) {
    lines.push(format(STRINGS.topic.info.line_project, { project: entry.project }));
    if (entry.path) lines.push(format(STRINGS.topic.info.line_path, { path: entry.path }));
  } else {
    lines.push(STRINGS.topic.info.line_no_project);
    lines.push(format(STRINGS.topic.info.line_cwd, { cwd: topicDirPath(tid, entry.slug) }));
  }
  if (entry.archivedAt) {
    lines.push(format(STRINGS.topic.info.line_archived, { ts: entry.archivedAt }));
  } else {
    lines.push(STRINGS.topic.info.line_active);
  }
  return lines.join("\n");
}

// Re-exported for handler wiring.
export { ensureTopicDir };
