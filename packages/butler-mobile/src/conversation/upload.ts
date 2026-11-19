import type { MessageFileRef } from "../../../butler-protocol/src/index.ts";
import { readEnvelope } from "../../../butler-protocol/src/client/envelope.ts";

export async function uploadMessageFile({ origin, token, sessionId, file }: {
  origin: string; token: string; sessionId: string; file: { uri: string; name: string; mimeType: string };
}): Promise<MessageFileRef> {
  const body = new FormData();
  // React Native accepts a URI file part; the DOM declaration only describes Blob.
  body.append("file", { uri: file.uri, name: file.name, type: file.mimeType } as unknown as Blob);
  body.append("session_id", sessionId);
  const response = await fetch(`${origin.replace(/\/$/, "")}/message-files`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body,
  });
  return readEnvelope<{ file: MessageFileRef }>(response.status, await response.json()).file;
}
