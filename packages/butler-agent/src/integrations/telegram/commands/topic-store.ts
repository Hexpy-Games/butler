// Disk-backed topic store. Reads and atomically writes
// `butler.config.json → telegram.topics[<tid>]`. Isolated from handlers so
// tests can point BUTLER_HOME at a temp dir.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "fs";
import { join, dirname } from "path";
import { butlerData } from "./butler.ts";

export type TopicEntry = {
  topicName: string
  slug: string
  project?: string
  path?: string
  archivedAt?: string
  lastAttachedProjects?: string[]
};

export type TopicsMap = Record<string, TopicEntry>;

function butlerConfigPath(): string {
  return join(butlerData(), "butler.config.json");
}

function topicDirRoot(): string {
  return join(butlerData(), "topics");
}

// Compatibility exports for older tests/helpers. Internal reads/writes use the
// dynamic helpers above so temp BUTLER_HOME/BUTLER_DATA changes are respected.
export const BUTLER_CONFIG_PATH = butlerConfigPath();
export const TOPIC_DIR_ROOT = topicDirRoot();

export const LAST_ATTACHED_MAX = 3;

type Config = Record<string, any>;

function readCfg(): Config {
  try { return JSON.parse(readFileSync(butlerConfigPath(), "utf8")); } catch { return {}; }
}

// Atomic write: `tmp → rename`. Handles concurrent writers from auto-register
// and the /topic flow. No locking — Last-write-wins is acceptable because
// config entries are keyed by thread_id (no cross-tid race).
function writeCfg(cfg: Config): void {
  mkdirSync(dirname(butlerConfigPath()), { recursive: true });
  const tmp = butlerConfigPath() + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  renameSync(tmp, butlerConfigPath());
}

export function readTopics(): TopicsMap {
  const cfg = readCfg();
  return (cfg?.telegram?.topics ?? {}) as TopicsMap;
}

export function readTopic(tid: string | number): TopicEntry | null {
  const t = readTopics()[String(tid)];
  return t ?? null;
}

export function writeTopic(tid: string | number, entry: TopicEntry): void {
  const cfg = readCfg();
  if (!cfg.telegram) cfg.telegram = {};
  if (!cfg.telegram.topics) cfg.telegram.topics = {};
  cfg.telegram.topics[String(tid)] = entry;
  writeCfg(cfg);
}

export function updateTopic(tid: string | number, patch: Partial<TopicEntry>): TopicEntry | null {
  const cfg = readCfg();
  const cur = cfg?.telegram?.topics?.[String(tid)];
  if (!cur) return null;
  const next = { ...cur, ...patch };
  if (!cfg.telegram) cfg.telegram = {};
  if (!cfg.telegram.topics) cfg.telegram.topics = {};
  cfg.telegram.topics[String(tid)] = next;
  writeCfg(cfg);
  return next;
}

export function deleteTopic(tid: string | number): void {
  const cfg = readCfg();
  if (cfg?.telegram?.topics) {
    delete cfg.telegram.topics[String(tid)];
    writeCfg(cfg);
  }
}

export function listTopics(): Array<{ tid: string } & TopicEntry> {
  const t = readTopics();
  return Object.entries(t).map(([tid, e]) => ({ tid, ...e }));
}

export function listArchivedTopics(): Array<{ tid: string } & TopicEntry> {
  return listTopics().filter(t => !!t.archivedAt);
}

export function pushRecentlyAttached(tid: string | number, projectName: string): void {
  const cur = readTopic(tid);
  if (!cur) return;
  const history = (cur.lastAttachedProjects ?? []).filter(p => p !== projectName);
  history.unshift(projectName);
  while (history.length > LAST_ATTACHED_MAX) history.pop();
  updateTopic(tid, { lastAttachedProjects: history });
}

// ── topic dir helpers ────────────────────────────────────────────────────────

export function topicDirName(tid: string | number, slug: string): string {
  return `${tid}-${slug}`;
}

export function topicDirPath(tid: string | number, slug: string): string {
  return join(topicDirRoot(), topicDirName(tid, slug));
}

export function ensureTopicDir(tid: string | number, slug: string): string {
  const p = topicDirPath(tid, slug);
  mkdirSync(p, { recursive: true });
  mkdirSync(join(p, ".butler"), { recursive: true });
  return p;
}

export function ensureTopicRoots(): void {
  mkdirSync(topicDirRoot(), { recursive: true });
}

export function renameTopicDir(
  tid: string | number,
  oldSlug: string,
  newSlug: string,
): string | null {
  const src = topicDirPath(tid, oldSlug);
  if (!existsSync(src)) return null;
  const dest = topicDirPath(tid, newSlug);
  if (existsSync(dest)) throw new Error(`topic dir already exists: ${dest}`);
  renameSync(src, dest);
  return dest;
}

// ── discovery ────────────────────────────────────────────────────────────────

export type DiscoveryEntry = { name: string; path: string; source: "config" | "discovery" };

export function readDiscoveryRoots(): string[] {
  const cfg = readCfg();
  const roots = cfg?.project?.discoveryRoots;
  if (!Array.isArray(roots)) return [];
  return roots.filter((r): r is string => typeof r === "string");
}

export function readTopicConfig(): Record<string, any> {
  const cfg = readCfg();
  return cfg?.telegram?.topic ?? {};
}

export function readAutoRegisterConfig(): Record<string, any> {
  const cfg = readCfg();
  return cfg?.telegram?.autoRegister ?? {};
}

export function readAckReaction(): string {
  const cfg = readCfg();
  const v = cfg?.telegram?.ackReaction;
  return typeof v === "string" && v.length > 0 ? v : "⚡";
}
