import { create } from "zustand";
import { apiErrorCode } from "./api";
import type { TimelineEvent } from "./types";
import type { ComputerConnection } from "../components/settings/computerTypes";

export type { ComputerConnection } from "../components/settings/computerTypes";

/** Relay state seeded by the connection route and updated by live events. */
export const useComputerConnections = create<{ states: Record<string, ComputerConnection> }>(() => ({ states: {} }));

export function setComputerConnection(id: string, state: ComputerConnection) {
  useComputerConnections.setState(({ states }) => ({ states: { ...states, [id]: state } }));
}

export function markComputerUnreachable(id: string | undefined, error: unknown) {
  const code = apiErrorCode(error);
  if (id && (code === "remote_unavailable" || code === "remote_request_failed" || code === "ssh_unreachable")) {
    setComputerConnection(id, "unreachable");
  }
}

export function publishComputerEvent(event: TimelineEvent) {
  if (event.type !== "remote.connection_changed") return;
  const payload = event.payload as { computer_id?: unknown; state?: unknown } | undefined;
  if (typeof payload?.computer_id === "string" && typeof payload.state === "string") {
    setComputerConnection(payload.computer_id, payload.state as ComputerConnection);
  }
}
