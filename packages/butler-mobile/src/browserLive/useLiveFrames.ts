import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { LIVE_SIGNAL_DEADLINE_MS, reconnectDelayMs, type ByteReader } from "../../../butler-protocol/src/client/index.ts";
import type { Route } from "@/connection/route";
import { LiveRecordParser } from "./records";
import { openLiveFrames } from "./stream";

type LiveState = {
  size?: { width: number; height: number };
  uri?: string;
  status: "connecting" | "live" | "ended" | "failed";
};

const connecting: LiveState = { status: "connecting" };

function frameUri(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024)));
  }
  return "data:image/jpeg;base64," + btoa(chunks.join(""));
}

export function useLiveFrames(route: Route | null, token: string | undefined, tab: string, width: number) {
  const [state, setState] = useState<LiveState>(connecting);
  const latestWidth = useRef(width);
  latestWidth.current = width;
  const ready = width > 0;

  useFocusEffect(useCallback(() => {
    if (!route || !token || !tab || !ready) return;
    let stop: (() => void) | undefined;
    const sync = () => {
      if (AppState.currentState === "active") {
        stop ??= connect(route, token, tab, latestWidth.current, setState);
      } else {
        stop?.();
        stop = undefined;
        setState(connecting);
      }
    };
    const subscription = AppState.addEventListener("change", sync);
    sync();
    return () => {
      subscription.remove();
      stop?.();
      setState(connecting);
    };
  }, [route, token, tab, ready]));

  return state;
}

function connect(
  route: Route, token: string, tab: string, width: number, update: Dispatch<SetStateAction<LiveState>>,
) {
  let stopped = false;
  let failures = 0;
  let abort: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const read = async () => {
    const controller = new AbortController();
    const { signal } = controller;
    abort = controller;
    let reader: ByteReader | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const resetDeadline = () => {
      clearTimeout(deadline);
      deadline = setTimeout(() => controller.abort(), LIVE_SIGNAL_DEADLINE_MS);
    };
    resetDeadline();
    try {
      const response = await openLiveFrames(route, token, tab, width, signal);
      if (response.status === 409) {
        const body = await response.json().catch(() => null) as { error?: { code?: string } } | null;
        if (!stopped && !signal.aborted) {
          update({ status: body?.error?.code === "live_unavailable" ? "failed" : "ended" });
          return;
        }
      }
      if (!response.ok || !response.body) throw new Error("Browser live stream unavailable");
      reader = response.body.getReader();
      const parser = new LiveRecordParser();
      const decoder = new TextDecoder();
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done || signal.aborted) break;
        if (!value) continue;
        for (const { type, payload } of parser.push(value)) {
          resetDeadline();
          if (type === 1) {
            const size = JSON.parse(decoder.decode(payload)) as LiveState["size"];
            update(state => ({ ...state, size }));
          }
          if (type === 2) {
            failures = 0;
            const uri = frameUri(payload);
            update(state => ({ ...state, status: "live", uri }));
          }
          if (type === 4) {
            update({ status: "ended" });
            return;
          }
        }
      }
    } catch {
      // Transport and parse failures reconnect with the same subscription width.
    } finally {
      clearTimeout(deadline);
      controller.abort();
      void reader?.cancel().catch(() => {});
    }
    if (!stopped) retry = setTimeout(() => void read(), reconnectDelayMs(failures++));
  };

  void read();
  return () => {
    stopped = true;
    abort?.abort();
    clearTimeout(retry);
  };
}
