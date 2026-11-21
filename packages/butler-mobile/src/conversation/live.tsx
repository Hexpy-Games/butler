import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { router } from "expo-router";
import { connectLive, createGatewayClient, type GatewayClient, type LiveConnection, type LiveEvent } from "../../../butler-protocol/src/client/index.ts";
import { nativeFetch } from "@/connection/nativeFetch";
import type { Pairing } from "@/connection/pairings";
import { pairingStore } from "@/connection/store";
import { showToast } from "@/ds";
import { useMobileCopy } from "@/i18n";

interface ConversationContext {
  connect(pairing: Pairing): void;
  disconnect(): Promise<void>;
  client: GatewayClient | null;
  pairing: Pairing | null;
  lost: boolean;
  reconcile: number;
  subscribe(listener: (event: LiveEvent) => void): () => void;
}
const Context = createContext<ConversationContext | null>(null);

export function ConversationProvider({ children }: { children: React.ReactNode }) {
  const copy = useMobileCopy();
  const pairing = useRef<Pairing | null>(null);
  const live = useRef<LiveConnection | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listeners = useRef(new Set<(event: LiveEvent) => void>());
  const [activePairing, setPairing] = useState<Pairing | null>(null);
  const [client, setClient] = useState<GatewayClient | null>(null);
  const [lost, setLost] = useState(false);
  const [reconcile, setReconcile] = useState(0);
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
    setPairing(null);
    setClient(null);
    try {
      if (current) await pairingStore.clear(current.butlerId);
    } finally {
      if (router.canDismiss()) router.dismissAll();
      router.replace("/pair");
    }
  }, []);
  const disconnect = useCallback(async () => {
    const current = pairing.current;
    live.current?.close(); // before the revoke, so the closed stream cannot fire the 401 toast
    if (current) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        await createGatewayClient({ origin: current.origin, fetch: nativeFetch, token: () => current.deviceToken })
          .request<void>("/devices/self", { method: "DELETE", signal: controller.signal });
      } catch {
        // Best effort: the computer may be off or the token already revoked.
      } finally {
        clearTimeout(timeout);
      }
    }
    await teardown();
  }, [teardown]);
  const connect = useCallback((next: Pairing) => {
    if (pairing.current?.origin === next.origin && pairing.current.deviceToken === next.deviceToken) return;
    live.current?.close();
    clearTimeout(timer.current);
    setLost(false);
    pairing.current = next;
    setPairing(next);
    const gateway = createGatewayClient({ origin: next.origin, fetch: nativeFetch, token: () => next.deviceToken });
    setClient(gateway);
    live.current = connectLive({
      client: gateway, cursor: 0,
      onEvent: event => listeners.current.forEach(listener => listener(event)),
      onReconcile: () => setReconcile(value => value + 1),
      onRecovered: () => setReconcile(value => value + 1),
      onLostChange(value) {
        clearTimeout(timer.current);
        if (value) timer.current = setTimeout(() => setLost(true), 2000);
        else setLost(false);
      },
      onError(error) {
        if (error.status !== 401 && error.code !== "local_auth_required") return;
        void teardown().then(() => {
          showToast({ message: copy.problems.needsPairing, tone: "warning" });
        });
      },
    });
    if (AppState.currentState === "background") live.current.pause();
  }, [copy, teardown]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => {
      if (state === "background") live.current?.pause();
      if (state === "active") live.current?.resume();
    });
    return () => {
      subscription.remove();
      live.current?.close();
      clearTimeout(timer.current);
    };
  }, []);
  return <Context.Provider value={{ connect, disconnect, client, pairing: activePairing, lost, reconcile, subscribe }}>{children}</Context.Provider>;
}

export function useConversation(): ConversationContext {
  const value = useContext(Context);
  if (!value) throw new Error("ConversationProvider is required");
  return value;
}
