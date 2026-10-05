/** An isolated test launcher pairs the renderer with its own foreground Agent. */
export async function testRendererConnection(serverUrl, request) {
  const response = await request("/connection-codes", { method: "POST" });
  const body = await response.json();
  const url = new URL(body?.data?.url);
  const server = new URL(serverUrl);
  if (!response.ok || url.origin !== server.origin || url.pathname !== "/connect") {
    throw new Error("Test connection does not belong to the foreground Agent");
  }
  return url.toString();
}
