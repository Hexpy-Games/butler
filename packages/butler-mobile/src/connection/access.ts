/** LAN: the gateway origin and the device token. Relay: the local proxy (api = path-token listener, content = cookie listener). */
export type Access = { kind: "lan"; origin: string; token: string } | { kind: "relay"; api: string; content: string; bt: string };

/** `data.url` of /outputs/:id/view and /message-files/:id/view: absolute on LAN (used as is), root-relative over the relay (served by the content proxy with ?bt=). */
export function contentUri(access: Access, url: string): string {
  if (access.kind === "lan" || !url.startsWith("/") || url.startsWith("//")) return url;
  const hash = url.indexOf("#");
  const [path, fragment] = hash < 0 ? [url, ""] : [url.slice(0, hash), url.slice(hash)];
  return `${access.content}${path}${path.includes("?") ? "&" : "?"}bt=${access.bt}${fragment}`;
}

/** Bytes the gateway serves on its API (message files, assets). Root-relative paths are joined as strings: new URL() would drop the proxy's /<token> prefix. */
export function fileSource(access: Access, path: string): { uri: string; headers: Record<string, string> } {
  if (access.kind === "relay") return path.startsWith("/") && !path.startsWith("//") ? { uri: access.api + path, headers: {} } : { uri: path, headers: {} };
  const url = new URL(path, access.origin);
  return { uri: url.href, headers: url.origin === new URL(access.origin).origin ? { Authorization: `Bearer ${access.token}` } : {} };
}
