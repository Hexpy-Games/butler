import { fetch as expoFetch } from "expo/fetch";
import { GatewayError, type AbortSignalLike, type ByteReader } from "../../../../butler-protocol/src/client/index.ts";
import { b64urlEncode } from "./b64url";
import { concat, EMPTY, utf8 } from "./bytes";
import { cloudError } from "./cloudError";
import { readMessage2, writeMessage1, type CipherState } from "./noise";
import { randomBytes } from "./random";
import { frame, RecordDecoder, sealBody } from "./records";

export type RelayPeer = { address: string; tunnelId: string; desktopStatic: Uint8Array; privateKey: Uint8Array; publicKey: Uint8Array };
export type TunnelRequest = { target: "api" | "content"; method: string; path: string; headers: Record<string, string>; body: Uint8Array | null; signal?: AbortSignalLike };
export type TunnelResponse = { status: number; headers: Record<string, string>; reader: ByteReader };

const MAX_REQUEST_BYTES = 67_108_864;

class RecordStream {
  private readonly decoder = new RecordDecoder();
  private queue: Uint8Array[] = [];
  constructor(readonly source: ByteReader) {}
  async next(): Promise<Uint8Array | null> {
    while (this.queue.length === 0) {
      const chunk = await this.source.read();
      if (chunk.done) return null;
      if (chunk.value) this.queue.push(...this.decoder.push(chunk.value));
    }
    return this.queue.shift()!;
  }
}

function lowercase(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

function readHead(payload: Uint8Array): { status: number; headers: Record<string, string> } {
  const value: unknown = JSON.parse(new TextDecoder().decode(payload));
  const status: unknown = value && typeof value === "object" ? Reflect.get(value, "status") : undefined;
  const headers: unknown = value && typeof value === "object" ? Reflect.get(value, "headers") : undefined;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) throw new Error("tunnel_protocol");
  const entries = headers && typeof headers === "object" ? Object.entries(headers) : [];
  return { status, headers: Object.fromEntries(entries.filter((entry): entry is [string, string] => typeof entry[1] === "string")) };
}

function transportReader(stream: RecordStream, receive: CipherState): ByteReader {
  let finished = false;
  return {
    async read() {
      if (finished) return { done: true };
      const record = await stream.next();
      if (!record) throw new Error("tunnel_truncated");
      const plain = receive.decrypt(EMPTY, record);
      if (plain.length === 0) { finished = true; return { done: true }; }
      return { done: false, value: plain };
    },
    cancel: () => stream.source.cancel(),
  };
}

/** Sends one request through the relay (§8) and resolves once the desktop's message 2 arrives. Cloud errors throw GatewayError. */
export async function tunnelRequest(peer: RelayPeer, request: TunnelRequest): Promise<TunnelResponse> {
  const bodyKey = randomBytes(32);
  const payload = {
    v: 1, ts: Date.now(), rid: b64urlEncode(randomBytes(16)), target: request.target, method: request.method,
    path: request.path, headers: lowercase(request.headers), body_key: b64urlEncode(bodyKey), has_body: request.body !== null,
  };
  const { message, pending } = writeMessage1(utf8(`butler-tunnel/1 ${peer.tunnelId}`), { privateKey: peer.privateKey, publicKey: peer.publicKey },
    peer.desktopStatic, randomBytes(32), utf8(JSON.stringify(payload)));
  const bytes = concat(...[message, ...(request.body ? sealBody(bodyKey, request.body) : [])].map(frame));
  if (bytes.length > MAX_REQUEST_BYTES) throw new GatewayError(413, "too_large", "too_large");
  const response = await expoFetch(`${peer.address}/r`, {
    method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes,
    signal: request.signal instanceof AbortSignal ? request.signal : undefined,
  });
  if (response.status !== 200) throw cloudError(response.status, await response.json().catch(() => null));
  const source = response.body?.getReader();
  if (!source) throw new Error("tunnel_protocol");
  const stream = new RecordStream(source);
  const first = await stream.next();
  if (!first) throw new Error("tunnel_truncated");
  const { payload: head, receive } = readMessage2(pending, first);
  return { ...readHead(head), reader: transportReader(stream, receive) };
}
