import type { MessageFileRef } from "../../../butler-protocol/src/index.ts";
import { readEnvelope } from "../../../butler-protocol/src/client/envelope.ts";

export async function uploadMessageFile({ origin, token, sessionId, file }: {
  origin: string; token: string; sessionId: string; file: { uri: string; name: string; mimeType: string };
}): Promise<MessageFileRef> {
  const body = new FormData();
  // expo/fetch (the SDK 58 global fetch) cannot send URI file parts; React Native's XHR can.
  body.append("file", { uri: file.uri, name: file.name, type: file.mimeType } as unknown as Blob);
  body.append("session_id", sessionId);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${origin.replace(/\/$/, "")}/message-files`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.onload = () => {
      try {
        const json = JSON.parse(xhr.responseText);
        resolve(readEnvelope<{ file: MessageFileRef }>(xhr.status, json).file);
      } catch (error) {
        reject(error);
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.ontimeout = () => reject(new Error("Upload timed out"));
    xhr.onabort = () => reject(new Error("Upload aborted"));
    xhr.send(body);
  });
}
