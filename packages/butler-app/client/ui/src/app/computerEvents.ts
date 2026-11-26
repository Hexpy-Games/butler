import { create } from "zustand";
import { api, apiErrorCode } from "./api";
import type { TimelineEvent } from "./types";
import type { Computer, ComputerConnection, MainModelKind } from "../components/settings/computerTypes";

export type { ComputerConnection } from "../components/settings/computerTypes";

/** Relay state seeded by the connection route and updated by live events. */
export const useComputerConnections = create<{ states: Record<string, ComputerConnection> }>(() => ({ states: {} }));

export const useComputerChanges = create<{ revision: number; signIn: Computer | null }>(() => ({ revision: 0, signIn: null }));

export function setComputerConnection(id: string, state: ComputerConnection) {
  useComputerConnections.setState(({ states }) => ({ states: { ...states, [id]: state } }));
}

export function markComputerUnreachable(id: string | undefined, error: unknown) {
  const code = apiErrorCode(error);
  if (id && (code === "remote_unavailable" || code === "remote_request_failed" || code === "ssh_unreachable")) {
    setComputerConnection(id, "unreachable");
  }
}

export function publishComputerEvent(event: TimelineEvent, { refreshNavigation, recent, openSettings }: {
  refreshNavigation(): void;
  recent: boolean;
  openSettings(section: string): Promise<boolean>;
}) {
  if (event.type === "computers.changed") {
    refreshNavigation();
    useComputerChanges.setState(({ revision }) => ({ revision: revision + 1 }));
    const payload = event.payload as { computer_id?: unknown; sign_in?: unknown } | undefined;
    if (recent && payload?.sign_in === true && typeof payload.computer_id === "string") {
      void openComputerSignIn(payload.computer_id, openSettings);
    }
  }
  if (event.type !== "remote.connection_changed") return;
  const payload = event.payload as { computer_id?: unknown; state?: unknown } | undefined;
  if (typeof payload?.computer_id === "string" && typeof payload.state === "string") {
    setComputerConnection(payload.computer_id, payload.state as ComputerConnection);
  }
}

export function listComputers(): Promise<{ computers: Computer[]; main_model: MainModelKind }> {
  return api("/computers");
}

async function openComputerSignIn(id: string, openSettings: (section: string) => Promise<boolean>) {
  const result = await listComputers().catch(() => undefined);
  const computer = result?.computers.find((entry) => entry.id === id);
  if (!computer) return;
  useComputerChanges.setState({ signIn: computer });
  if (!await openSettings("security")) useComputerChanges.setState({ signIn: null });
}
