import { useCallback, useEffect, useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { AppState } from "react-native";
import type { MobileCopy } from "../../../butler-i18n/src/index.ts";
import { connectLive, createGatewayClient, type FetchLike, type GatewayClient, type LiveConnection, type LiveEvent } from "../../../butler-protocol/src/client/index.ts";
import type { Access } from "@/connection/access";
import { nativeFetch } from "@/connection/nativeFetch";
import type { Pairing } from "@/connection/pairings";
import type { ProbeResult } from "@/connection/probe";
import { problemFrom, type Problem } from "@/connection/problems";
import { useRelayProxy } from "@/connection/proxy/useRelayProxy";
import { loadRelayPeer } from "@/connection/relayPeer";
import { chooseRoute, type Route } from "@/connection/route";
import { createRelayFetch } from "@/connection/tunnel/relayFetch";
import type { RelayPeer } from "@/connection/tunnel/transport";
import { showToast } from "@/ds";

interface LiveRouteOptions {
  copy: MobileCopy;
  pairing: RefObject<Pairing | null>;
  route: RefObject<Route | null>;
  relay: RefObject<{ peer: RelayPeer; fetch: FetchLike } | null>;
  rerouting: RefObject<number>;
  live: RefObject<LiveConnection | null>;
  timer: RefObject<ReturnType<typeof setTimeout> | undefined>;
  listeners: RefObject<Set<(event: LiveEvent) => void>>;
  activePairing: Pairing | null;
  activeRoute: Route | null;
  peer: RelayPeer | null;
  setPairing: (pairing: Pairing) => void;
  setRoute: (route: Route) => void;
  setPeer: (peer: RelayPeer | null) => void;
  setProblem: (problem: Problem | null) => void;
  setClient: (client: GatewayClient) => void;
  setLost: (lost: boolean) => void;
  setReconcile: Dispatch<SetStateAction<number>>;
  teardown: () => Promise<void>;
}

export function useLiveRoute({
  copy, pairing, route, relay, rerouting, live, timer, listeners, activePairing, activeRoute, peer,
  setPairing, setRoute, setPeer, setProblem, setClient, setLost, setReconcile, teardown,
}: LiveRouteOptions) {
  const reroute = useRef<() => Promise<void>>(async () => {});
  const proxy = useRelayProxy(activeRoute?.kind === "relay" ? peer : null, activePairing?.deviceToken ?? null);
  const access = useMemo<Access | null>(() => !activePairing || !activeRoute ? null
    : activeRoute.kind === "lan" ? { kind: "lan", origin: activeRoute.origin, token: activePairing.deviceToken }
    : proxy ? { kind: "relay", ...proxy } : null, [activePairing, activeRoute, proxy]);
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
  }, [copy, listeners, live, pairing, route, setClient, setLost, setPairing, setProblem, setReconcile, setRoute, teardown, timer]);
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
  }, [connect, pairing, relay, route, setPeer]);
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
  }, [live, timer]);
  return { access, open };
}
