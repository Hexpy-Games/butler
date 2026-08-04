import type {
  CreateProjectRequest,
  CreateSessionRequest,
  UpdateSessionRequest,
} from "./navigation-contract.ts";

export function isCreateSessionRequest(
  value: unknown,
): value is CreateSessionRequest {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<CreateSessionRequest>;
  if (input.kind !== "chat" && input.kind !== "project") return false;
  if ("title" in input && typeof input.title !== "string") return false;
  if ("initial_message" in input && typeof input.initial_message !== "string")
    return false;
  if ("project_id" in input && typeof input.project_id !== "string")
    return false;
  if ("session_hint" in input && typeof input.session_hint !== "string")
    return false;
  if ("idempotency_key" in input && typeof input.idempotency_key !== "string")
    return false;
  return true;
}

const UPDATE_SESSION_KEYS = new Set(["title", "archived"]);

export function isUpdateSessionRequest(
  value: unknown,
): value is UpdateSessionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (!Object.keys(input).every((key) => UPDATE_SESSION_KEYS.has(key)))
    return false;
  if ("title" in input && typeof input.title !== "string") return false;
  if ("archived" in input && typeof input.archived !== "boolean") return false;
  return true;
}

export function isCreateProjectRequest(
  value: unknown,
): value is CreateProjectRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const input = value as Partial<CreateProjectRequest>;
  if (input.source !== "scratch" && input.source !== "existing_folder") {
    return false;
  }
  if (
    input.source === "scratch" &&
    (typeof input.display_name !== "string" ||
      input.display_name.trim().length === 0)
  ) {
    return false;
  }
  if (
    input.display_name !== undefined &&
    typeof input.display_name !== "string"
  ) {
    return false;
  }
  if (
    input.folder_selection_token !== undefined &&
    typeof input.folder_selection_token !== "string"
  ) {
    return false;
  }
  if (
    input.idempotency_key !== undefined &&
    typeof input.idempotency_key !== "string"
  ) {
    return false;
  }
  return true;
}
