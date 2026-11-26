import type { ByteReader, FetchLike } from "../../../../butler-protocol/src/client/index.ts";
import { concat, utf8 } from "./bytes";
import { tunnelRequest, type RelayPeer } from "./transport";

async function readAll(reader: ByteReader): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) if (chunk.value) parts.push(chunk.value);
  return concat(...parts);
}

/** URLs are `<relay address><path>`, as createGatewayClient builds them with origin = the relay address. */
export function createRelayFetch(peer: RelayPeer): FetchLike {
  return async (url, init) => {
    if (!url.startsWith(`${peer.address}/`)) throw new Error("relay_url");
    const body = init.body === undefined ? null : typeof init.body === "string" ? utf8(init.body) : init.body;
    const response = await tunnelRequest(peer, { target: "api", method: init.method, path: url.slice(peer.address.length), headers: init.headers, body, signal: init.signal });
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      body: { getReader: () => response.reader },
      json: async () => JSON.parse(new TextDecoder().decode(await readAll(response.reader))),
    };
  };
}
