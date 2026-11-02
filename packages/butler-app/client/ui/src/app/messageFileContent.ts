/** Authenticated JSON read for stored attachment metadata, independent of expiring image links. */
export async function readMessageFileJson(fileId: string): Promise<Record<string, unknown>> {
  if (!/^file-[0-9a-f-]{36}$/iu.test(fileId)) throw new Error("Invalid file");
  const bridge = window.butlerApp?.readMessageFileJson;
  let value: unknown;
  if (bridge) value = await bridge({ fileId });
  else {
    const response = await fetch(`/message-files/${encodeURIComponent(fileId)}`);
    if (!response.ok) throw new Error("Selection metadata is unavailable.");
    value = await response.json();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid selection metadata.");
  return value as Record<string, unknown>;
}
