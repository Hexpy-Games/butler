import { File } from "expo-file-system";
import type { MessageFileRef } from "../../../butler-protocol/src/index.ts";
import { readEnvelope } from "../../../butler-protocol/src/client/envelope.ts";
import type { Route } from "@/connection/route";
import { b64urlEncode } from "@/connection/tunnel/b64url";
import { multipartBody } from "@/connection/tunnel/multipart";
import { randomBytes } from "@/connection/tunnel/random";

export async function uploadMessageFile({ route, token, sessionId, file }: {
  route: Route; token: string; sessionId?: string; file: { uri: string; name: string; mimeType: string };
}): Promise<MessageFileRef> {
  if (route.kind === "lan") return xhrUpload(route.origin, token, sessionId, file);
  const boundary = `butler-${b64urlEncode(randomBytes(12))}`;
  const body = multipartBody(boundary, [
    { name: "file", filename: file.name, type: file.mimeType, bytes: await new File(file.uri).bytes() },
    ...(sessionId ? [{ name: "session_id", value: sessionId }] : []),
  ]);
  const response = await route.fetch(`${route.origin}/message-files`, {
    method: "POST", body,
    headers: { accept: "application/json", Authorization: `Bearer ${token}`, "content-type": `multipart/form-data; boundary=${boundary}` },
  });
  return readEnvelope<{ file: MessageFileRef }>(response.status, await response.json().catch(() => null)).file;
}

function xhrUpload(origin: string, token: string, sessionId: string | undefined, file: { uri: string; name: string; mimeType: string }): Promise<MessageFileRef> {
  const body = new FormData();
  // expo/fetch (the SDK 58 global fetch) cannot send URI file parts; React Native's XHR can.
  body.append("file", { uri: file.uri, name: file.name, type: file.mimeType } as unknown as Blob);
  if (sessionId) body.append("session_id", sessionId);
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
