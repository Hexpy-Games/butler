// Auto-registration for unknown forum threads. Per B.6 (10-step flow):
//   access gate → general-topic skip → rate limit → name lookup → slug →
//   dir mkdir → config atomic write → ack reaction → silent notification →
//   steward spawn.
//
// Pure-ish: fs + config mutations live in topic-store; all telegram side
// effects flow through the `AutoRegisterDeps.forum` shape so tests can stub.

import { STRINGS, format } from "./strings.ko.ts";
import { resolveAutoRegisterConfig } from "./defaults.ts";
import { topicSlug, uniqueSlug, TokenBucket } from "./topic-util.ts";
import {
  readTopic, writeTopic, readTopics, ensureTopicDir,
  readAutoRegisterConfig, readAckReaction,
} from "./topic-store.ts";

export type AutoRegisterForumApi = {
  // silent notification: disable_notification true sends without push ping.
  sendTopicMessage: (chatId: string | number, threadId: number, text: string) => Promise<void>
  // ack reaction on the inbound message.
  reactToMessage: (chatId: string | number, messageId: number, emoji: string) => Promise<void>
};

export type AutoRegisterDeps = {
  forum: AutoRegisterForumApi
  // Spawn a steward session for the new topic. windowName must be `t<tid>-<slug>`
  // when project is unattached (per B.7.3). No-op acceptable in tests.
  spawnSession?: (args: {
    windowName: string
    cwd: string
    firstMessage: string
    threadId: number
    chatId: string | number
  }) => Promise<void> | void
  log?: (msg: string) => void
};

export type AutoRegisterIncoming = {
  chatId: string | number
  threadId: number
  messageId: number
  messageText: string
  // optional topic-name hints (grammy surfaces these on the message object)
  forumTopicCreatedName?: string | null
  replyForumTopicCreatedName?: string | null
};

export type AutoRegisterResult =
  | { action: "registered"; slug: string; topicName: string }
  | { action: "skipped"; reason: "general" | "already-registered" | "rate-limited"; }
  | { action: "failed"; reason: string };

// Singleton bucket — keyed on the rate-limit config. We rebuild the bucket
// lazily when config changes meaningfully (rate / burst).
let _bucket: TokenBucket | null = null;
let _bucketKey = "";

function getBucket(): TokenBucket {
  const cfg = resolveAutoRegisterConfig(readAutoRegisterConfig());
  const key = `${cfg.rateLimitPerMinute}:${cfg.burst}:${cfg.windowSec}`;
  if (!_bucket || _bucketKey !== key) {
    _bucket = new TokenBucket(cfg.burst, cfg.rateLimitPerMinute / 60);
    _bucketKey = key;
  }
  return _bucket;
}

// Reset hook for tests.
export function __resetBucketForTesting(): void {
  _bucket = null;
  _bucketKey = "";
}

export function lookupTopicName(inc: AutoRegisterIncoming): string {
  if (inc.forumTopicCreatedName) return inc.forumTopicCreatedName;
  if (inc.replyForumTopicCreatedName) return inc.replyForumTopicCreatedName;
  return `t${inc.threadId}`;
}

export function chooseSlug(topicName: string, threadId: number): string {
  const base = topicSlug(topicName, threadId);
  const taken = Object.values(readTopics())
    .map(t => t.slug)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  return uniqueSlug(base, taken);
}

export async function autoRegisterUnknownTopic(
  deps: AutoRegisterDeps,
  inc: AutoRegisterIncoming,
): Promise<AutoRegisterResult> {
  // Caller must perform access gate BEFORE calling this function (per B.6 step
  // 1). We assume access already passed.
  if (readTopic(inc.threadId)) {
    return { action: "skipped", reason: "already-registered" };
  }
  const bucket = getBucket();
  if (!bucket.tryConsume()) {
    // silent rate-limit alert to the topic itself (best-effort)
    try {
      await deps.forum.sendTopicMessage(inc.chatId, inc.threadId, STRINGS.autoregister.rate_limited);
    } catch {}
    return { action: "skipped", reason: "rate-limited" };
  }
  const topicName = lookupTopicName(inc);
  const slug = chooseSlug(topicName, inc.threadId);

  // Topic dir first — if fs fails we don't want a config entry pointing at
  // nothing.
  let dir: string;
  try {
    dir = ensureTopicDir(inc.threadId, slug);
  } catch (e) {
    deps.log?.(`auto-register: mkdir failed: ${(e as Error).message}`);
    return { action: "failed", reason: (e as Error).message };
  }

  try {
    writeTopic(inc.threadId, { topicName, slug });
  } catch (e) {
    deps.log?.(`auto-register: config write failed: ${(e as Error).message}`);
    return { action: "failed", reason: (e as Error).message };
  }

  // Ack reaction (best-effort). ackReaction lives at telegram.ackReaction
  // (top-level telegram config), not under autoRegister — see spec B.8.
  const ackEmoji = readAckReaction();
  try {
    await deps.forum.reactToMessage(inc.chatId, inc.messageId, ackEmoji);
  } catch (e) {
    deps.log?.(`auto-register: ack reaction failed: ${(e as Error).message}`);
  }

  // Silent notification in the new topic (best-effort)
  const text = format(STRINGS.autoregister.registered, { topicName, slug });
  try {
    await deps.forum.sendTopicMessage(inc.chatId, inc.threadId, text);
  } catch (e) {
    deps.log?.(`auto-register: notify failed: ${(e as Error).message}`);
  }

  // Steward spawn (best-effort — if this fails the topic is still registered)
  if (deps.spawnSession) {
    try {
      await deps.spawnSession({
        windowName: `t${inc.threadId}-${slug}`,
        cwd: dir,
        firstMessage: inc.messageText,
        threadId: inc.threadId,
        chatId: inc.chatId,
      });
    } catch (e) {
      deps.log?.(`auto-register: steward spawn failed: ${(e as Error).message}`);
    }
  }

  return { action: "registered", slug, topicName };
}

// Used by callers that only want to classify whether a message is general /
// unknown / known before routing.
export type ThreadClassification =
  | { kind: "general" }
  | { kind: "known"; topic: NonNullable<ReturnType<typeof readTopic>> }
  | { kind: "unknown"; threadId: number }
  | { kind: "direct" };

export function classifyThread(opts: {
  threadId: number | null | undefined
  isForum: boolean
}): ThreadClassification {
  if (opts.threadId == null) {
    if (opts.isForum) return { kind: "general" };
    return { kind: "direct" };
  }
  const existing = readTopic(opts.threadId);
  if (existing) return { kind: "known", topic: existing };
  return { kind: "unknown", threadId: opts.threadId };
}
