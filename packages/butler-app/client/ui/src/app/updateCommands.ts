import { api } from "./api";
import type { UpdateApplyResult, UpdateComponentId } from "./types";

/** Shared Settings/sidebar action, including the preload's restart coordinator. */
export function applyComponentUpdate(component: UpdateComponentId): Promise<UpdateApplyResult> {
  return api<UpdateApplyResult>("/updates/apply", {
    method: "POST", body: JSON.stringify({ component }),
  });
}
