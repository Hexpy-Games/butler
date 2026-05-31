import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type TodoPriority = "low" | "normal" | "high";
export type TodoPhase =
  | "conception"
  | "planning"
  | "execution"
  | "review"
  | "consolidation"
  | "reporting";

export interface TodoItemInput {
  id?: string;
  content: string;
  active_form: string;
  status: TodoStatus;
  phase?: TodoPhase;
  priority?: TodoPriority;
  blocked_by?: string[];
  note?: string;
}

export interface TodoItem {
  id: string;
  content: string;
  active_form: string;
  status: TodoStatus;
  phase: TodoPhase | null;
  priority: TodoPriority;
  blocked_by: string[];
  note: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TodoListRecord {
  version: 1;
  list_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  items: TodoItem[];
}

export interface TodoProgressSummary {
  total: number;
  pending: number;
  in_progress: number;
  completed: number;
  cancelled: number;
  active: number;
  progress_pct: number;
  current: TodoItem | null;
}

export interface TodoListView {
  list: TodoListRecord;
  items: TodoItem[];
  progress: TodoProgressSummary;
}

const STATUS_VALUES: TodoStatus[] = ["pending", "in_progress", "completed", "cancelled"];
const PRIORITY_VALUES: TodoPriority[] = ["low", "normal", "high"];
const PHASE_VALUES: TodoPhase[] = [
  "conception",
  "planning",
  "execution",
  "review",
  "consolidation",
  "reporting",
];
const MAX_TODO_ITEMS = 100;

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function safeListId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "main";
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(trimmed)) {
    throw new Error("todo list_id must be 1-80 safe characters");
  }
  return trimmed;
}

function normalizeStatus(value: unknown): TodoStatus {
  if (STATUS_VALUES.includes(value as TodoStatus)) return value as TodoStatus;
  throw new Error(`unsupported todo status: ${String(value)}`);
}

function normalizePriority(value: unknown): TodoPriority {
  if (value === undefined || value === null || value === "") return "normal";
  if (PRIORITY_VALUES.includes(value as TodoPriority)) return value as TodoPriority;
  throw new Error(`unsupported todo priority: ${String(value)}`);
}

function normalizePhase(value: unknown): TodoPhase | null {
  if (value === undefined || value === null || value === "") return null;
  if (PHASE_VALUES.includes(value as TodoPhase)) return value as TodoPhase;
  throw new Error(`unsupported todo phase: ${String(value)}`);
}

function stableTodoId(content: string, ordinal: number): string {
  const digest = createHash("sha1").update(`${content}\n${ordinal}`).digest("hex").slice(0, 10);
  return `todo-${digest}`;
}

function safeTodoId(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(trimmed)) {
    throw new Error("todo id must be 1-80 safe characters");
  }
  return trimmed;
}

function normalizeItems(input: {
  now: string;
  prior: TodoListRecord | null;
  items: TodoItemInput[];
}): TodoItem[] {
  if (!Array.isArray(input.items)) throw new Error("todo update requires items");
  if (input.items.length > MAX_TODO_ITEMS) {
    throw new Error(`todo list may contain at most ${MAX_TODO_ITEMS} items`);
  }
  const priorById = new Map(input.prior?.items.map((item) => [item.id, item]) ?? []);
  const seen = new Set<string>();
  const items = input.items.map((item, index) => {
    const content = item.content.trim();
    const activeForm = item.active_form.trim();
    if (!content) throw new Error("todo content must be non-empty");
    if (!activeForm) throw new Error("todo active_form must be non-empty");
    const id = item.id ? safeTodoId(item.id) : stableTodoId(content, index);
    if (seen.has(id)) throw new Error(`duplicate todo id at index ${index}: ${id}`);
    seen.add(id);
    const previous = priorById.get(id);
    const status = normalizeStatus(item.status);
    const completedAt = status === "completed"
      ? previous?.status === "completed" ? previous.completed_at : input.now
      : null;
    return {
      id,
      content,
      active_form: activeForm,
      status,
      phase: normalizePhase(item.phase),
      priority: normalizePriority(item.priority),
      blocked_by: Array.isArray(item.blocked_by)
        ? item.blocked_by.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)
        : [],
      note: typeof item.note === "string" && item.note.trim() ? item.note.trim() : null,
      created_at: previous?.created_at ?? input.now,
      updated_at: input.now,
      completed_at: completedAt,
    } satisfies TodoItem;
  });
  const inProgress = items.filter((item) => item.status === "in_progress");
  if (inProgress.length > 1) {
    throw new Error("todo list may have at most one in_progress item");
  }
  for (const [index, item] of items.entries()) {
    for (const blocker of item.blocked_by) {
      if (!seen.has(blocker)) {
        throw new Error(`todo item at index ${index} references unknown blocked_by id: ${blocker}`);
      }
      if (blocker === item.id) {
        throw new Error(`todo item at index ${index} cannot block itself: ${blocker}`);
      }
    }
  }
  assertAcyclicBlockedBy(items);
  return items;
}

function assertAcyclicBlockedBy(items: TodoItem[]): void {
  const blockersById = new Map(items.map((item) => [item.id, item.blocked_by]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string, trail: string[]): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`todo blocked_by dependency cycle detected: ${[...trail, id].join(" -> ")}`);
    }
    visiting.add(id);
    for (const blocker of blockersById.get(id) ?? []) {
      visit(blocker, [...trail, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const item of items) {
    visit(item.id, []);
  }
}

export function summarizeTodoProgress(items: TodoItem[]): TodoProgressSummary {
  const pending = items.filter((item) => item.status === "pending").length;
  const inProgress = items.filter((item) => item.status === "in_progress").length;
  const completed = items.filter((item) => item.status === "completed").length;
  const cancelled = items.filter((item) => item.status === "cancelled").length;
  const active = pending + inProgress;
  const denominator = pending + inProgress + completed;
  return {
    total: items.length,
    pending,
    in_progress: inProgress,
    completed,
    cancelled,
    active,
    progress_pct: denominator > 0 ? Math.round((completed / denominator) * 100) : 100,
    current: items.find((item) => item.status === "in_progress") ?? null,
  };
}

export class TodoListStore {
  readonly todosDir: string;

  constructor(readonly butlerData: string) {
    this.todosDir = join(butlerData, "todos");
  }

  listPath(listId = "main"): string {
    return join(this.todosDir, `${safeListId(listId)}.json`);
  }

  read(listId = "main"): TodoListRecord | null {
    return readJson<TodoListRecord>(this.listPath(listId));
  }

  update(input: {
    listId?: string;
    title?: string | null;
    items: TodoItemInput[];
    now?: Date;
  }): TodoListView {
    const listId = safeListId(input.listId ?? "main");
    const prior = this.read(listId);
    const now = (input.now ?? new Date()).toISOString();
    const items = normalizeItems({
      now,
      prior,
      items: input.items,
    });
    const record: TodoListRecord = {
      version: 1,
      list_id: listId,
      title: typeof input.title === "string" && input.title.trim()
        ? input.title.trim()
        : prior?.title ?? null,
      created_at: prior?.created_at ?? now,
      updated_at: now,
      items,
    };
    writeJsonAtomic(this.listPath(listId), record);
    return this.view(listId, { includeCompleted: true });
  }

  view(
    listId = "main",
    opts: { includeCompleted?: boolean } = {},
  ): TodoListView {
    const record = this.read(listId) ?? {
      version: 1,
      list_id: safeListId(listId),
      title: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      items: [],
    } satisfies TodoListRecord;
    const includeCompleted = opts.includeCompleted === true;
    const items = includeCompleted
      ? record.items
      : record.items.filter((item) => item.status !== "completed" && item.status !== "cancelled");
    return {
      list: record,
      items,
      progress: summarizeTodoProgress(record.items),
    };
  }

  listIds(): string[] {
    if (!existsSync(this.todosDir)) return [];
    return readdirSync(this.todosDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort();
  }
}
