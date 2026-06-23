import type { TodoItemInput } from "../work/todo-list.ts";
import { sanitizePublicText } from "../events/turn-events.ts";
import type { RuntimeMessageLanguage } from "../output/messages.ts";

const INTERNAL_PROGRESS_TOOLS = new Set([
  "update_todo_list",
  "list_todo_list",
]);

export const WORKER_ORCHESTRATION_START_TOOLS = [
  "dispatch_worker",
  "resume_worker",
  "run_planned_task",
  "repair_planned_task",
  "run_ready_work_streams",
] as const;

export const WORKER_ORCHESTRATION_START_TOOL_SET = new Set<string>(WORKER_ORCHESTRATION_START_TOOLS);

export function isInternalProgressTool(name: string): boolean {
  return INTERNAL_PROGRESS_TOOLS.has(name);
}

export function activeTodoWorkBlockFromArgs(args: Record<string, unknown>): {
  id: string;
  label: string;
} | null {
  const active = todoProgressItemsFromArgs(args).find((item) => item.state === "running");
  if (!active) return null;
  return {
    id: `work-todo-${active.id}`,
    label: active.label,
  };
}

export function todoProgressItemsFromArgs(args: Record<string, unknown>): Array<{
  id: string;
  label: string;
  state: string;
  phase: string | null;
  order: number;
}> {
  const todos = Array.isArray(args.todos) ? args.todos : [];
  return todos
    .filter((todo): todo is Record<string, unknown> =>
      Boolean(todo && typeof todo === "object" && !Array.isArray(todo)))
    .map((todo, index) => {
      const rawStatus = typeof todo.status === "string" ? todo.status : "pending";
      const status = rawStatus === "in_progress" ||
        rawStatus === "completed" ||
        rawStatus === "cancelled"
        ? rawStatus
        : "pending";
      const preferredLabel = status === "in_progress"
        ? todo.active_form ?? todo.content
        : todo.content ?? todo.active_form;
      const label = sanitizePublicText(preferredLabel, "").trim();
      const rawId = typeof todo.id === "string" && todo.id.trim()
        ? todo.id.trim()
        : `todo-${index + 1}`;
      return {
        id: sanitizeTodoId(rawId, index),
        label,
        state: todoProgressState(status),
        phase: todoProgressPhase(todo.phase),
        order: index + 1,
      };
    })
    .filter((item) => item.label)
    .slice(0, 8);
}

export function runtimeSemanticTodoItems(input: {
  language: RuntimeMessageLanguage;
  executionLabel: string;
  state: "execution" | "review" | "complete";
}): TodoItemInput[] {
  const ko = input.language === "ko";
  const fallback = ko ? "필요한 도구 작업을 실행합니다." : "Run the needed tool work.";
  const executionLabel = sanitizePublicText(input.executionLabel, fallback).slice(0, 180) || fallback;
  const status = (phase: TodoItemInput["phase"]): TodoItemInput["status"] => {
    if (input.state === "complete") return "completed";
    if (phase === "execution") return input.state === "execution" ? "in_progress" : "completed";
    if (phase === "review") return input.state === "review" ? "in_progress" : "pending";
    if (phase === "conception" || phase === "planning") return "completed";
    return "pending";
  };
  return [
    todo({
      id: "orient",
      label: ko ? "요청 의도 확인" : "Understand the request",
      activeForm: ko ? "요청 의도를 확인합니다." : "Understanding the request.",
      status: status("conception"),
      phase: "conception",
    }),
    todo({
      id: "plan",
      label: ko ? "확인 경로 준비" : "Prepare the evidence path",
      activeForm: ko ? "확인 경로를 준비합니다." : "Preparing the evidence path.",
      status: status("planning"),
      phase: "planning",
    }),
    todo({
      id: "execute",
      label: executionLabel,
      activeForm: executionLabel,
      status: status("execution"),
      phase: "execution",
    }),
    todo({
      id: "review",
      label: ko ? "도구 결과 검토" : "Review tool evidence",
      activeForm: ko ? "도구 결과를 검토합니다." : "Reviewing tool evidence.",
      status: status("review"),
      phase: "review",
    }),
    todo({
      id: "consolidate",
      label: ko ? "핵심 결과 정리" : "Consolidate the result",
      activeForm: ko ? "핵심 결과를 정리합니다." : "Consolidating the result.",
      status: status("consolidation"),
      phase: "consolidation",
    }),
    todo({
      id: "report",
      label: ko ? "사용자에게 보고" : "Report to the user",
      activeForm: ko ? "사용자에게 보고합니다." : "Reporting to the user.",
      status: status("reporting"),
      phase: "reporting",
    }),
  ];
}

export function shouldSynthesizeRuntimeSemanticProgress(input: {
  callName: string;
  args: Record<string, unknown>;
}): boolean {
  if (isInternalProgressTool(input.callName)) return false;
  if (WORKER_ORCHESTRATION_START_TOOL_SET.has(input.callName)) return false;
  if (input.callName !== "run_command") return false;
  const command = typeof input.args.command === "string" ? input.args.command : "";
  return /[;&|]|\n/u.test(command);
}

function sanitizeTodoId(rawId: string, index: number): string {
  return sanitizePublicText(rawId, `todo-${index + 1}`)
    .replace(/[^a-zA-Z0-9_-]/gu, "-")
    .slice(0, 64) || `todo-${index + 1}`;
}

function todoProgressPhase(value: unknown): string | null {
  if (
    value === "conception" ||
    value === "planning" ||
    value === "execution" ||
    value === "review" ||
    value === "consolidation" ||
    value === "reporting"
  ) {
    return value;
  }
  return null;
}

function todoProgressState(status: string): string {
  if (status === "in_progress") return "running";
  if (status === "completed") return "delivered";
  if (status === "cancelled") return "cancelled";
  return "accepted";
}

function todo(input: {
  id: string;
  label: string;
  activeForm: string;
  status: TodoItemInput["status"];
  phase: TodoItemInput["phase"];
}): TodoItemInput {
  return {
    id: input.id,
    content: input.label,
    active_form: input.activeForm,
    status: input.status,
    phase: input.phase,
  };
}
