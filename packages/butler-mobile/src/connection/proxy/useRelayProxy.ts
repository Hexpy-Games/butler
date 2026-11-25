import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { b64urlEncode } from "../tunnel/b64url";
import { randomBytes } from "../tunnel/random";
import { tunnelRequest, type RelayPeer } from "../tunnel/transport";
import { apiAuth, contentAuth, forwardHeaders, responseHeaders } from "./auth";
import { ButlerProxy, type ProxyRequestEvent } from "./native";

export type ProxyBase = { api: string; content: string; bt: string };
type Ports = { content: number; api: number };

function reply(id: number, status: number) {
  ButlerProxy.respondHead(id, status, { "content-type": "text/plain; charset=utf-8", "content-length": "0" });
  ButlerProxy.respondEnd(id);
}

async function serve(event: ProxyRequestEvent, ports: Ports, contentToken: string, apiToken: string, peer: RelayPeer, deviceToken: string, inflight: Map<number, AbortController>) {
  const content = event.port === ports.content;
  const auth = content ? contentAuth(contentToken, event.target, event.headers.cookie) : apiAuth(apiToken, event.target);
  if (!auth.ok) return reply(event.id, 404);
  if (event.method !== "GET" && event.method !== "HEAD") return reply(event.id, 405);
  const controller = new AbortController();
  inflight.set(event.id, controller);
  let started = false;
  try {
    const headers = forwardHeaders(event.headers);
    if (!content) headers.authorization = `Bearer ${deviceToken}`;
    const response = await tunnelRequest(peer, { target: content ? "content" : "api", method: event.method, path: auth.path, headers, body: null, signal: controller.signal });
    ButlerProxy.respondHead(event.id, response.status, responseHeaders(response.headers, auth.setCookie ? contentToken : null));
    started = true;
    if (event.method !== "HEAD") {
      for (let chunk = await response.reader.read(); !chunk.done; chunk = await response.reader.read()) {
        if (chunk.value) await ButlerProxy.respondChunk(event.id, chunk.value);
      }
    } else void response.reader.cancel().catch(() => {});
    ButlerProxy.respondEnd(event.id);
  } catch {
    if (started) ButlerProxy.respondAbort(event.id); else reply(event.id, 502);
  } finally {
    inflight.delete(event.id);
  }
}

export function useRelayProxy(peer: RelayPeer | null, deviceToken: string | null): ProxyBase | null {
  const [base, setBase] = useState<ProxyBase | null>(null);
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => {
      if (state === "background") setForeground(false);
      if (state === "active") setForeground(true);
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!peer || !deviceToken || !foreground) return;
    const contentToken = b64urlEncode(randomBytes(32));
    const apiToken = b64urlEncode(randomBytes(32));
    const inflight = new Map<number, AbortController>();
    const started: number[] = [];
    let ports: Ports | null = null, closed = false;
    const request = ButlerProxy.addListener("onRequest", event => {
      if (ports && (event.port === ports.content || event.port === ports.api)) void serve(event, ports, contentToken, apiToken, peer, deviceToken, inflight);
    });
    const cancel = ButlerProxy.addListener("onCancel", ({ id }) => inflight.get(id)?.abort());
    void (async () => {
      try {
        started.push(await ButlerProxy.start());
        started.push(await ButlerProxy.start());
      } catch {
        // Leaves base null: relay content stays unavailable until the next foreground.
      }
      if (closed || started.length < 2) { started.forEach(port => ButlerProxy.stop(port)); return; }
      ports = { content: started[0], api: started[1] };
      setBase({ content: `http://127.0.0.1:${started[0]}`, api: `http://127.0.0.1:${started[1]}/${apiToken}`, bt: contentToken });
    })();
    return () => {
      closed = true;
      request.remove(); cancel.remove();
      inflight.forEach(controller => controller.abort());
      if (ports) started.forEach(port => ButlerProxy.stop(port));
      setBase(null);
    };
  }, [peer, deviceToken, foreground]);
  return base;
}
