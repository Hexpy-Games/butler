export interface AppUpdateState {
  status: "idle" | "choice_required" | "deferred" | "preparing" | "restarting" | "failed";
  request_id: string | null;
}
export function createAppUpdateCoordinator(input: {
  readActiveWork: () => Promise<{ classification: string }>;
  watchWork: (onChange: () => void) => () => void;
  stopForUpdate: () => Promise<{ update_ready: boolean }>;
  onState: (state: AppUpdateState) => void;
}): {
  state: () => AppUpdateState;
  request: (prepare: () => Promise<{ activate: () => void | Promise<void>; cancel: () => void }>) => Promise<{ status: string; update_started: boolean }>;
  choose: (input: { request_id: string | null; action: string }) => { ok: boolean };
  dispose: () => void;
};
