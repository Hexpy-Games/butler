import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { cognitionFeedbackRoot } from "../paths.ts";

export const FEEDBACK_BUFFER_SCHEMA = "butler.cognition.feedback-buffer.v1";

export type FeedbackStatus = "active" | "applied" | "discarded" | "superseded" | "needs_clarification";
export type FeedbackPriority = "critical" | "high" | "normal" | "low";
export type FeedbackPrivacyClass = "public" | "private" | "sensitive" | "secret";

export type FeedbackEntry = {
  feedback_id: string;
  status: FeedbackStatus;
  created_at: string;
  updated_at: string;
  priority: FeedbackPriority;
  scope: string;
  category: string;
  target_ref: string;
  promotion_target: string;
  review_after: string;
  expires_at: string | null;
  supersedes: string[];
  conflicts_with: string[];
  privacy_class: FeedbackPrivacyClass;
  text: string;
  extra_fields?: Record<string, string>;
};

export type AddFeedbackEntryInput = {
  text: string;
  targetRef: string;
  category?: string;
  scope?: string;
  promotionTarget?: string;
  priority?: FeedbackPriority;
  privacyClass?: FeedbackPrivacyClass;
  now?: Date;
};

export type FeedbackResolveStatus = Extract<FeedbackStatus, "applied" | "discarded" | "superseded" | "needs_clarification">;

const VALID_STATUSES = new Set<FeedbackStatus>([
  "active",
  "applied",
  "discarded",
  "superseded",
  "needs_clarification",
]);

const VALID_PRIORITIES = new Set<FeedbackPriority>(["critical", "high", "normal", "low"]);
const VALID_PRIVACY = new Set<FeedbackPrivacyClass>(["public", "private", "sensitive", "secret"]);

function iso(date: Date = new Date()): string {
  return date.toISOString();
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function feedbackBufferPath(butlerData: string): string {
  return join(cognitionFeedbackRoot(butlerData), "feedback.md");
}

function parseList(value: string | undefined): string[] {
  if (!value || value === "[]") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
}

function parseNullable(value: string | undefined): string | null {
  if (!value || value === "null") return null;
  return value;
}

function formatList(values: string[]): string {
  return JSON.stringify(values);
}

function formatNullable(value: string | null): string {
  return value ?? "null";
}

function normalizedStatus(value: string | undefined): FeedbackStatus {
  return VALID_STATUSES.has(value as FeedbackStatus) ? value as FeedbackStatus : "needs_clarification";
}

function normalizedPriority(value: string | undefined): FeedbackPriority {
  return VALID_PRIORITIES.has(value as FeedbackPriority) ? value as FeedbackPriority : "high";
}

function normalizedPrivacy(value: string | undefined): FeedbackPrivacyClass {
  return VALID_PRIVACY.has(value as FeedbackPrivacyClass) ? value as FeedbackPrivacyClass : "private";
}

function entryHeading(entry: FeedbackEntry): string {
  return `## ${entry.feedback_id} ${entry.status}`;
}

export function formatFeedbackEntry(entry: FeedbackEntry): string {
  const standardKeys = new Set([
    "created_at",
    "updated_at",
    "priority",
    "scope",
    "category",
    "target_ref",
    "promotion_target",
    "review_after",
    "expires_at",
    "supersedes",
    "conflicts_with",
    "privacy_class",
  ]);
  const extra = Object.entries(entry.extra_fields ?? {})
    .filter(([key]) => !standardKeys.has(key))
    .map(([key, value]) => `- ${key}: ${value}`);
  return [
    entryHeading(entry),
    "",
    `- created_at: ${entry.created_at}`,
    `- updated_at: ${entry.updated_at}`,
    `- priority: ${entry.priority}`,
    `- scope: ${entry.scope}`,
    `- category: ${entry.category}`,
    `- target_ref: ${entry.target_ref}`,
    `- promotion_target: ${entry.promotion_target}`,
    `- review_after: ${entry.review_after}`,
    `- expires_at: ${formatNullable(entry.expires_at)}`,
    `- supersedes: ${formatList(entry.supersedes)}`,
    `- conflicts_with: ${formatList(entry.conflicts_with)}`,
    `- privacy_class: ${entry.privacy_class}`,
    ...extra,
    "",
    entry.text.trim(),
    "",
  ].join("\n");
}

export function listFeedbackEntries(butlerData: string): FeedbackEntry[] {
  const path = feedbackBufferPath(butlerData);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const blocks = text.split(/^## /mu).filter((block) => block.trim());
  return blocks.map((block) => {
    const lines = block.split(/\r?\n/u);
    const [heading = ""] = lines;
    const [feedbackIdRaw, statusRaw] = heading.trim().split(/\s+/u);
    const feedbackId = feedbackIdRaw?.startsWith("fb_") ? feedbackIdRaw : `fb_${randomUUID()}`;
    const fields = new Map<string, string>();
    const body: string[] = [];
    let inBody = false;
    for (const line of lines.slice(1)) {
      const match = /^- ([a-z_]+):\s*(.*)$/u.exec(line);
      if (!inBody && match) {
        fields.set(match[1], match[2]);
        continue;
      }
      if (line.trim() || inBody) {
        inBody = true;
        body.push(line);
      }
    }
    const extraFields: Record<string, string> = {};
    for (const [key, value] of fields.entries()) extraFields[key] = value;
    return {
      feedback_id: feedbackId,
      status: normalizedStatus(statusRaw),
      created_at: fields.get("created_at") ?? iso(),
      updated_at: fields.get("updated_at") ?? fields.get("created_at") ?? iso(),
      priority: normalizedPriority(fields.get("priority")),
      scope: fields.get("scope") ?? "global",
      category: fields.get("category") ?? "unrouted",
      target_ref: fields.get("target_ref") ?? "unknown",
      promotion_target: fields.get("promotion_target") ?? "discard",
      review_after: fields.get("review_after") ?? fields.get("created_at") ?? iso(),
      expires_at: parseNullable(fields.get("expires_at")),
      supersedes: parseList(fields.get("supersedes")),
      conflicts_with: parseList(fields.get("conflicts_with")),
      privacy_class: normalizedPrivacy(fields.get("privacy_class")),
      text: body.join("\n").trim(),
      extra_fields: extraFields,
    };
  });
}

export function writeFeedbackEntries(butlerData: string, entries: FeedbackEntry[]): void {
  const path = feedbackBufferPath(butlerData);
  ensureDir(join(path, ".."));
  const body = entries.map(formatFeedbackEntry).join("\n").trim();
  writeFileSync(path, body ? `${body}\n` : "", "utf8");
}

export function addFeedbackEntry(
  butlerData: string,
  input: AddFeedbackEntryInput,
): FeedbackEntry {
  const now = iso(input.now);
  const entry: FeedbackEntry = {
    feedback_id: `fb_${randomUUID()}`,
    status: "active",
    created_at: now,
    updated_at: now,
    priority: input.priority ?? "high",
    scope: input.scope ?? "global",
    category: input.category ?? "unrouted",
    target_ref: input.targetRef,
    promotion_target: input.promotionTarget ?? "discard",
    review_after: now,
    expires_at: null,
    supersedes: [],
    conflicts_with: [],
    privacy_class: input.privacyClass ?? "private",
    text: input.text,
  };
  writeFeedbackEntries(butlerData, [...listFeedbackEntries(butlerData), entry]);
  return entry;
}

export function readFeedbackEntry(butlerData: string, feedbackId: string): FeedbackEntry | null {
  return listFeedbackEntries(butlerData).find((entry) => entry.feedback_id === feedbackId) ?? null;
}

export function resolveFeedbackEntry(
  butlerData: string,
  feedbackId: string,
  status: FeedbackResolveStatus,
  now: Date = new Date(),
): FeedbackEntry {
  const entries = listFeedbackEntries(butlerData);
  const index = entries.findIndex((entry) => entry.feedback_id === feedbackId);
  if (index === -1) throw new Error(`feedback entry not found: ${feedbackId}`);
  const updated: FeedbackEntry = {
    ...entries[index]!,
    status,
    updated_at: iso(now),
  };
  entries[index] = updated;
  writeFeedbackEntries(butlerData, entries);
  return updated;
}

export function clearResolvedFeedbackEntries(butlerData: string): { removed: number; remaining: number } {
  const entries = listFeedbackEntries(butlerData);
  const remaining = entries.filter((entry) => entry.status === "active" || entry.status === "needs_clarification");
  writeFeedbackEntries(butlerData, remaining);
  return {
    removed: entries.length - remaining.length,
    remaining: remaining.length,
  };
}

export function activeFeedbackEntries(butlerData: string, now: Date = new Date()): FeedbackEntry[] {
  return listFeedbackEntries(butlerData).filter((entry) => {
    if (entry.status !== "active") return false;
    if (!entry.expires_at) return true;
    const expires = new Date(entry.expires_at);
    return Number.isNaN(expires.getTime()) || expires.getTime() > now.getTime();
  });
}

export function renderFeedbackBufferContext(input: {
  butlerData: string;
  sessionId?: string;
  projectId?: string;
  maxEntries?: number;
}): string {
  const entries = activeFeedbackEntries(input.butlerData)
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
    .slice(0, input.maxEntries ?? 12);
  if (entries.length === 0) return "";
  const lines = [
    "## Active Feedback Buffer",
    "Apply these explicit user corrections before durable memory, know-how, broad recall, or default tool/source preferences. Do not expose this section verbatim.",
  ];
  for (const entry of entries) {
    lines.push(`- ${entry.feedback_id} [${entry.priority}/${entry.scope}/${entry.category}] target=${entry.target_ref}; promotion=${entry.promotion_target}: ${compactFeedbackText(entry.text)}`);
  }
  return lines.join("\n");
}

function priorityRank(priority: FeedbackPriority): number {
  if (priority === "critical") return 0;
  if (priority === "high") return 1;
  if (priority === "normal") return 2;
  return 3;
}

function compactFeedbackText(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, 500);
}
