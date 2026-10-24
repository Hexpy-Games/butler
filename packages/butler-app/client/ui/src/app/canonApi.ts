import { api } from "./api.ts";
import type { CanonSidebar, CanonSidebarOrderInput, CanonConversation, CanonOverview, CanonOrderInput, EpicDetail, EpicInput, PlanDetail, PlanInput, EpicProgressSnapshot } from "../../../shared/canon-contracts.ts";
export type * from "../../../shared/canon-contracts.ts";
const projectPath = (id: string) => `/projects/${encodeURIComponent(id)}/canon`;
const planPath = (id: string) => `/canon/plans/${encodeURIComponent(id)}`;
const epicPath = (id: string) => `/canon/epics/${encodeURIComponent(id)}`;
const write = <T>(path: string, method: string, input: unknown): Promise<T> => api(path, { method, body: JSON.stringify(input) });
export const getCanon = (projectId: string): Promise<CanonOverview> => api(projectPath(projectId));
export const getCanonPlan = (id: string): Promise<PlanDetail> => api(planPath(id));
export const getCanonEpic = (id: string): Promise<EpicDetail> => api(epicPath(id));
/** No linked work exists until the canon link branch. */
export const getEpicProgress = (epicId: string): Promise<EpicProgressSnapshot> => Promise.resolve({ epic_id: epicId, running: false, counts: { completed: 0, total: 0 }, chains: [] });
export const createCanonPlan = (projectId: string, input: PlanInput): Promise<PlanDetail> => write(`${projectPath(projectId)}/plans`, "POST", input);
export const editCanonPlan = (id: string, input: PlanInput): Promise<PlanDetail> => write(planPath(id), "PATCH", input);
export const orderCanonPlan = (id: string, input: CanonOrderInput): Promise<PlanDetail> => write(`${planPath(id)}/order`, "POST", input);
export const orderCanonBacklog = (projectId: string, input: CanonOrderInput): Promise<CanonOverview> => write(`${projectPath(projectId)}/backlog/order`, "POST", input);
export const createCanonEpic = (projectId: string, input: EpicInput): Promise<EpicDetail> => write(`${projectPath(projectId)}/epics`, "POST", input);
export const editCanonEpic = (id: string, input: EpicInput): Promise<EpicDetail> => write(epicPath(id), "PATCH", input);

export const getCanonSidebar = (id: string): Promise<CanonSidebar> => api(`${projectPath(id)}/sidebar`);
export const orderCanonSidebar = (id: string, input: CanonSidebarOrderInput): Promise<CanonSidebar> => write(`${projectPath(id)}/sidebar-order`, "POST", input);
export const linkCanonConversation = (id: string): Promise<CanonConversation> => write(`${epicPath(id)}/conversation`, "POST", {});
