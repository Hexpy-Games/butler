import { createContext, useCallback, useContext, useRef, useState } from "react";
import { router } from "expo-router";
import { createGatewayClient, type FetchLike, type GatewayClient, type LiveConnection, type LiveEvent } from "../../../butler-protocol/src/client/index.ts";
import type { Access } from "@/connection/access";
import type { Pairing } from "@/connection/pairings";
import type { ProbeResult } from "@/connection/probe";
import type { Problem } from "@/connection/problems";
import type { Route } from "@/connection/route";
import { pairingStore } from "@/connection/store";
import type { RelayPeer } from "@/connection/tunnel/transport";
import { clearSessionViews } from "./sessionViewCache";
import { useLiveRoute } from "./useLiveRoute";

interface ConversationContext {
  open(pairing: Pairing): Promise<ProbeResult>; // replaces connect: chooses the route, connects when ready
  disconnect(): Promise<void>;
  client: GatewayClient | null;
  secureClient: GatewayClient | null;
  pairing: Pairing | null;
  revoked: { computerName?: string } | null;
  route: Route | null;
  access: Access | null;
  lost: boolean;
  problem: Problem | null; // only "desktopOffline", from the last relay error; cleared when the stream is back
  reconcile: number;
  subscribe(listener: (event: LiveEvent) => void): () => void;
}
const Context = createContext<ConversationContext | null>(null);

export function ConversationProvider({ children }: { children: React.ReactNode }) {
  const pairing = useRef<Pairing | null>(null);
  const route = useRef<Route | null>(null);
  const relay = useRef<{ peer: RelayPeer; fetch: FetchLike } | null>(null);
  const rerouting = useRef(0);
  const live = useRef<LiveConnection | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listeners = useRef(new Set<(event: LiveEvent) => void>());
  const [activePairing, setPairing] = useState<Pairing | null>(null);
  const [revoked, setRevoked] = useState<ConversationContext["revoked"]>(null);
  const [activeRoute, setRoute] = useState<Route | null>(null);
  const [peer, setPeer] = useState<RelayPeer | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [client, setClient] = useState<GatewayClient | null>(null);
  const [lost, setLost] = useState(false);
  const [reconcile, setReconcile] = useState(0);
  const subscribe = useCallback((listener: (event: LiveEvent) => void) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);
  const teardown = useCallback(async (revoked?: Pairing) => {
    const current = revoked ?? pairing.current;
    live.current?.close();
    clearTimeout(timer.current);
    setLost(false);
    pairing.current = null;
    route.current = null;
    relay.current = null;
    rerouting.current++;
    setRoute(null);
    setPeer(null);
    setProblem(null);
    setPairing(null);
    setClient(null);
    try {
      if (current) {
        await pairingStore.clear(current.butlerId);
        clearSessionViews();
      }
    } finally {
      if (revoked) setRevoked({ computerName: revoked.computerName });
      if (router.canDismiss()) router.dismissAll();
      router.replace(revoked ? "/home" : "/pair");
    }
  }, []);
  const disconnect = useCallback(async () => {
    const current = pairing.current;
    const currentRoute = route.current;
    live.current?.close(); // before the revoke, so the closed stream cannot handle the 401
    if (current && currentRoute) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        await createGatewayClient({ origin: currentRoute.origin, fetch: currentRoute.fetch, token: () => current.deviceToken })
          .request<void>("/devices/self", { method: "DELETE", signal: controller.signal });
      } catch {
        // Best effort: the computer may be off or the token already revoked.
      } finally {
        clearTimeout(timeout);
      }
    }
    await teardown();
  }, [teardown]);
  const { access, open, secureClient } = useLiveRoute({
    pairing, route, relay, rerouting, live, timer, listeners, activePairing, activeRoute, client, peer,
    setPairing, setRoute, setPeer, setProblem, setClient, setLost, setReconcile, setRevoked, teardown,
  });
  return <Context.Provider value={{ open, disconnect, client, secureClient, pairing: activePairing, revoked, route: activeRoute, access, lost, problem, reconcile, subscribe }}>{children}</Context.Provider>;
}

export function useConversation(): ConversationContext {
  const value = useContext(Context);
  if (!value) throw new Error("ConversationProvider is required");
  return value;
}
