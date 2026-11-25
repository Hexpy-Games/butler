import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { router } from "expo-router";
import { connectLive, createGatewayClient, type FetchLike, type GatewayClient, type LiveConnection, type LiveEvent } from "../../../butler-protocol/src/client/index.ts";
import type { Access } from "@/connection/access";
import { nativeFetch } from "@/connection/nativeFetch";
import type { Pairing } from "@/connection/pairings";
import type { ProbeResult } from "@/connection/probe";
import { problemFrom, type Problem } from "@/connection/problems";
import { useRelayProxy } from "@/connection/proxy/useRelayProxy";
import { loadRelayPeer } from "@/connection/relayPeer";
import { chooseRoute, type Route } from "@/connection/route";
import { pairingStore } from "@/connection/store";
import { createRelayFetch } from "@/connection/tunnel/relayFetch";
import type { RelayPeer } from "@/connection/tunnel/transport";
import { showToast } from "@/ds";
import { useMobileCopy } from "@/i18n";
import { clearSessionViews } from "./sessionViewCache";

interface ConversationContext {
  open(pairing: Pairing): Promise<ProbeResult>; // replaces connect: chooses the route, connects when ready
  disconnect(): Promise<void>;
  client: GatewayClient | null;
  pairing: Pairing | null;
  route: Route | null;
  access: Access | null;
  lost: boolean;
  problem: Problem | null; // only "desktopOffline" | "relayOff", from the last relay error; cleared when the stream is back
  reconcile: number;
  subscribe(listener: (event: LiveEvent) => void): () => void;
}
const Context = createContext<ConversationContext | null>(null);

export function ConversationProvider({ children }: { children: React.ReactNode }) {
  const copy = useMobileCopy();
  const pairing = useRef<Pairing | null>(null);
  const route = useRef<Route | null>(null);
  const relay = useRef<{ peer: RelayPeer; fetch: FetchLike } | null>(null);
  const rerouting = useRef(0);
  const reroute = useRef<() => Promise<void>>(async () => {});
  const live = useRef<LiveConnection | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listeners = useRef(new Set<(event: LiveEvent) => void>());
  const [activePairing, setPairing] = useState<Pairing | null>(null);
  const [activeRoute, setRoute] = useState<Route | null>(null);
  const [peer, setPeer] = useState<RelayPeer | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [client, setClient] = useState<GatewayClient | null>(null);
  const [lost, setLost] = useState(false);
  const [reconcile, setReconcile] = useState(0);
  const proxy = useRelayProxy(activeRoute?.kind === "relay" ? peer : null, activePairing?.deviceToken ?? null);
  const access = useMemo<Access | null>(() => !activePairing || !activeRoute ? null
    : activeRoute.kind === "lan" ? { kind: "lan", origin: activeRoute.origin, token: activePairing.deviceToken }
    : proxy ? { kind: "relay", ...proxy } : null, [activePairing, activeRoute, proxy]);
  const subscribe = useCallback((listener: (event: LiveEvent) => void) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);
  const teardown = useCallback(async () => {
    const current = pairing.current;
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
      if (router.canDismiss()) router.dismissAll();
      router.replace("/pair");
    }
  }, []);
  const disconnect = useCallback(async () => {
    const current = pairing.current;
    const currentRoute = route.current;
    live.current?.close(); // before the revoke, so the closed stream cannot fire the 401 toast
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
  const connect = useCallback((next: Pairing, nextRoute: Route, cursor = 0) => {
    if (pairing.current?.deviceToken === next.deviceToken && route.current?.origin === nextRoute.origin) return;
    live.current?.close();
    clearTimeout(timer.current);
    setLost(false); setProblem(null);
    pairing.current = next; route.current = nextRoute;
    setPairing(next); setRoute(nextRoute);
    const gateway = createGatewayClient({ origin: nextRoute.origin, fetch: nextRoute.fetch, token: () => next.deviceToken });
    setClient(gateway);
    live.current = connectLive({
      client: gateway, cursor,
      onEvent: event => listeners.current.forEach(listener => listener(event)),
      onReconcile: () => setReconcile(value => value + 1),
      onRecovered: () => setReconcile(value => value + 1),
      onLostChange(value) {
        clearTimeout(timer.current);
        if (value) timer.current = setTimeout(() => { setLost(true); void reroute.current(); }, 2000);
        else { setLost(false); setProblem(null); }
      },
      onError(error) {
        if (error.status === 401 || error.code === "local_auth_required") {
          void teardown().then(() => showToast({ message: copy.problems.needsPairing, tone: "warning" }));
          return;
        }
        const found = problemFrom(error);
        setProblem(found === "desktopOffline" || found === "relayOff" ? found : null);
      },
    });
    if (AppState.currentState === "background") live.current.pause();
  }, [copy, teardown]);
  reroute.current = async () => {
    const current = pairing.current;
    if (!current || current.addresses.length < 2) return;
    const id = ++rerouting.current;
    const result = await chooseRoute(current, nativeFetch, relay.current?.fetch ?? null);
    if (id !== rerouting.current || pairing.current !== current) return;
    if (result.kind === "ready" && result.route.origin !== route.current?.origin) {
      connect(current, result.route, live.current?.cursor ?? 0);
      setReconcile(value => value + 1);
    } else if (result.kind === "problem" && (result.problem === "desktopOffline" || result.problem === "relayOff")) setProblem(result.problem);
  };
  const open = useCallback(async (next: Pairing): Promise<ProbeResult> => {
    const nextPeer = await loadRelayPeer(next).catch(() => null);
    const relayFetch = nextPeer ? createRelayFetch(nextPeer) : null;
    const result = await chooseRoute(next, nativeFetch, relayFetch);
    if (result.kind === "problem") return { kind: "problem", problem: result.problem };
    if (pairing.current?.deviceToken !== next.deviceToken || route.current?.origin !== result.route.origin) {
      relay.current = nextPeer && relayFetch ? { peer: nextPeer, fetch: relayFetch } : null;
      setPeer(nextPeer);
      connect(next, result.route);
    }
    return { kind: "ready" };
  }, [connect]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => {
      if (state === "background") live.current?.pause();
      if (state === "active") { live.current?.resume(); void reroute.current(); }
    });
    return () => {
      subscription.remove();
      live.current?.close();
      clearTimeout(timer.current);
    };
  }, []);
  return <Context.Provider value={{ open, disconnect, client, pairing: activePairing, route: activeRoute, access, lost, problem, reconcile, subscribe }}>{children}</Context.Provider>;
}

export function useConversation(): ConversationContext {
  const value = useContext(Context);
  if (!value) throw new Error("ConversationProvider is required");
  return value;
}
