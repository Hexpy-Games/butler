import {
  apiEnvelope,
  type MessageFileUploadResult,
} from "../../protocol/app-protocol.ts";
import {
  contentDispositionForAttachment,
  isUploadFile,
  safeOptionalString,
} from "../form-data.ts";
import { json, RequestError } from "../responses.ts";
import type { AppRouteContext } from "../server-types.ts";

const MESSAGE_FILE_ID_PATTERN = /^file-[0-9a-f-]{36}$/iu;

export async function handleMessageFileRoutes(
  input: AppRouteContext,
): Promise<Response | null> {
  if (input.request.method === "POST" && input.url.pathname === "/message-files") {
    const form = await input.request.formData().catch(() => null);
    if (!form) {
      throw new RequestError(
        400,
        "invalid_multipart",
        "File upload must be multipart form data.",
      );
    }

    const file = form.get("file");
    if (!isUploadFile(file)) {
      throw new RequestError(400, "file_required", "A file field is required.");
    }

    const bytes = await file.arrayBuffer();
    return json(
      apiEnvelope<MessageFileUploadResult>(
        input.store.createMessageFile({
          ownerSessionId: safeOptionalString(form.get("session_id")),
          name: file.name,
          mimeType: file.type,
          bytes,
        }),
      ),
      201,
    );
  }

  const fileMatch =
    input.request.method === "GET"
      ? input.url.pathname.match(/^\/message-files\/([^/]+)$/u)
      : null;
  if (!fileMatch) return null;

  const fileId = decodeURIComponent(fileMatch[1]!);
  if (!MESSAGE_FILE_ID_PATTERN.test(fileId)) {
    throw new RequestError(
      404,
      "message_file_not_found",
      "Message file was not found.",
    );
  }

  const { file, bytes } = input.store.getMessageFileDownload(fileId);
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": file.mime_type,
      "content-length": String(bytes.byteLength),
      "content-disposition": contentDispositionForAttachment(file.safe_name),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
