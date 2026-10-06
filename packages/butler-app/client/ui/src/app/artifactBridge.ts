/** Keep the desktop artifact routes on the existing authenticated preload. */
export function artifactBridgeInput(method: string, url: URL): { method: string; input: unknown } | null {
  if (method !== "GET") return null;
  if (url.pathname === "/artifacts") return {
    method: "listArtifacts",
    input: { sessionId:url.searchParams.get("session_id") ?? url.searchParams.get("sessionId") },
  };
  const output = url.pathname.match(/^\/outputs\/([a-f0-9]{64})\/view$/u);
  return output ? { method:"getOutputView", input:{ outputId:output[1], revision:url.searchParams.get("revision") ?? undefined } } : null;
}
