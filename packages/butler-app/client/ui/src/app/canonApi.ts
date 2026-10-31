import { api, callBridge } from "./api.ts";
import { appCopy } from "./copy.ts";
import type { MessageFileRef } from "./types.ts";
import type { CanonTag, CanonTagCreateInput, CanonTagEditInput, CanonSidebar, CanonSidebarOrderInput, CanonConversation, CanonOverview, CanonOrderInput, EpicDetail, EpicInput, PlanDetail, PlanInput, EpicProgressSnapshot, CanonConversationInput } from "../../../shared/canon-contracts.ts";
export type * from "../../../shared/canon-contracts.ts";
const projectPath = (id: string) => `/projects/${encodeURIComponent(id)}/canon`;
const planPath = (id: string) => `/canon/plans/${encodeURIComponent(id)}`;
const epicPath = (id: string) => `/canon/epics/${encodeURIComponent(id)}`;
const write = <T>(path: string, method: string, input: unknown): Promise<T> => api(path, { method, body: JSON.stringify(input) });
export const getCanonTags = (projectId: string): Promise<CanonTag[]> => api(`${projectPath(projectId)}/tags`);
export const createCanonTag = (projectId: string, input: CanonTagCreateInput): Promise<CanonTag> => write(`${projectPath(projectId)}/tags`, "POST", input);
export const editCanonTag = (id: string, input: CanonTagEditInput): Promise<CanonTag> => write(`/canon/tags/${encodeURIComponent(id)}`, "PATCH", input);
export const deleteCanonTag = (id: string): Promise<{ id: string }> => api(`/canon/tags/${encodeURIComponent(id)}`, { method: "DELETE" });
export const getCanon = (projectId: string): Promise<CanonOverview> => api(projectPath(projectId));
export const getCanonPlan = (id: string): Promise<PlanDetail> => api(planPath(id));
export const checkCanonCriterion = (nodeId: string, criterionId: string, input: { confirmed: boolean; expected_revision: number }): Promise<unknown> => write(`/canon/specs/${encodeURIComponent(nodeId)}/criteria/${encodeURIComponent(criterionId)}`, "POST", input);
export const getCanonEpic = (id: string): Promise<EpicDetail> => api(epicPath(id));
export const getEpicProgress = (epicId: string): Promise<EpicProgressSnapshot> => api(`${epicPath(epicId)}/progress`);
export const createCanonPlan = (projectId: string, input: PlanInput): Promise<PlanDetail> => write(`${projectPath(projectId)}/plans`, "POST", input);
export const editCanonPlan = (id: string, input: PlanInput): Promise<PlanDetail> => write(planPath(id), "PATCH", input);
export const orderCanonPlan = (id: string, input: CanonOrderInput): Promise<PlanDetail> => write(`${planPath(id)}/order`, "POST", input);
export const orderCanonBacklog = (projectId: string, input: CanonOrderInput): Promise<CanonOverview> => write(`${projectPath(projectId)}/backlog/order`, "POST", input);
export const createCanonEpic = (projectId: string, input: EpicInput): Promise<EpicDetail> => write(`${projectPath(projectId)}/epics`, "POST", input);
export const deleteCanonEpic = (id: string, expected_revision: number): Promise<{ id: string }> => write(epicPath(id), "DELETE", { expected_revision });
export const editCanonEpic = (id: string, input: EpicInput): Promise<EpicDetail> => write(epicPath(id), "PATCH", input);

export const getCanonSidebar = (id: string): Promise<CanonSidebar> => api(`${projectPath(id)}/sidebar`);
export const orderCanonSidebar = (id: string, input: CanonSidebarOrderInput): Promise<CanonSidebar> => write(`${projectPath(id)}/sidebar-order`, "POST", input);
export const linkCanonConversation = (id: string, { sessionId }: CanonConversationInput = {}): Promise<CanonConversation> => write(`${epicPath(id)}/conversation`, "POST", { session_id: sessionId });

export async function uploadCanonFile(projectId: string, file: File): Promise<MessageFileRef> {
  const bridge = typeof window !== "undefined" ? window.butlerApp : undefined;
  if (typeof bridge?.uploadCanonFile === "function") {
    const result = await callBridge<{ file: MessageFileRef }>(bridge, "uploadCanonFile", {
      projectId, name: file.name, mimeType: file.type, bytes: await file.arrayBuffer(),
    });
    return result.file;
  }
  const form = new FormData();
  form.set("file", file, file.name);
  const response = await fetch(`/projects/${encodeURIComponent(projectId)}/canon/files`, { method: "POST", body: form });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(appCopy.interfaceFeedback.uploadFailed), {
    code: payload?.error?.code, status: response.status,
  });
  return payload.data.file as MessageFileRef;
}
