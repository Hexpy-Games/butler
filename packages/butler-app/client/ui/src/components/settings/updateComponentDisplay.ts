import type {
  ComponentUpdateStatus,
  UpdateComponentId,
} from "../../app/types.ts";

export const UPDATE_COMPONENTS: UpdateComponentId[] = [
  "app",
];


export function bundledAgentVersionLabel(
  status: ComponentUpdateStatus,
): string | null {
  if (status.component !== "app") return null;
  if (!status.bundled_agent_version) return null;
  return `Butler Agent ${status.bundled_agent_version}`;
}
