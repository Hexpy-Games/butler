import { api } from "./api.ts";
import type { ProjectDashboardPreferencesPatch, ProjectDashboardView, ProjectWallpaper } from "./types.ts";

/** A gateway request (`api` by default; tests pass a double). */
export type GatewayRequest = <T>(path: string, init?: { method?: string; body?: string }) => Promise<T>;

/**
 * Stores a project's wallpaper (`inherit` or a source) under the dashboard
 * preferences revision (CAS) and resolves the next revision. Without a known
 * revision it reads the current one first. When the PATCH fails because the
 * revision moved (another write won), it refetches the revision and retries
 * once; other failures, or a second conflict, reject. Revisions are
 * compared rather than error codes, which do not survive the desktop bridge.
 */
export async function saveProjectWallpaper(
  projectId: string,
  wallpaper: ProjectWallpaper,
  { revision, request = api }: { revision?: number; request?: GatewayRequest } = {},
): Promise<number> {
  const dashboard = `/projects/${encodeURIComponent(projectId)}/dashboard`;
  const latest = async () => (await request<ProjectDashboardView>(dashboard)).preferences?.revision ?? 0;
  const patch = async (expectedRevision: number) => {
    const body: ProjectDashboardPreferencesPatch = { expectedRevision, wallpaper };
    return (await request<{ revision: number }>(`${dashboard}/preferences`, { method: "PATCH", body: JSON.stringify(body) })).revision;
  };
  const expected = revision ?? await latest();
  try {
    return await patch(expected);
  } catch (error) {
    const current = await latest();
    if (current === expected) throw error;
    return await patch(current);
  }
}
