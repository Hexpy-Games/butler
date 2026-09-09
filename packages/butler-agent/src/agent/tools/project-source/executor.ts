import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ResolvedProjectSource } from "../../../foundation/message-content.ts";
import type { ButlerToolCall } from "../types.ts";

export function readProjectSource(call: ButlerToolCall, input: { butlerData: string; sources: readonly ResolvedProjectSource[] }) {
  const fileId = call.args.file_id;
  if (typeof fileId !== "string" || !/^file-[a-zA-Z0-9_-]+$/u.test(fileId)) return { ok: false, error: "source_unavailable" };
  const source = input.sources.find((item) => item.originalRef.fileId === fileId);
  if (!source) return { ok: false, error: "source_not_admitted" };
  let offset = 0;
  // Strict provider schemas may require optional string fields to be present.
  // An empty cursor is the documented first page, not an opaque continuation.
  if (call.args.cursor !== undefined && call.args.cursor !== "") {
    try {
      if (typeof call.args.cursor !== "string" || call.args.cursor.length > 1024) throw new Error();
      const cursor = JSON.parse(Buffer.from(call.args.cursor, "base64url").toString("utf8"));
      if (cursor.fileId !== fileId || cursor.digest !== source.originalRef.sha256 || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error();
      offset = cursor.offset;
    } catch { return { ok: false, error: "invalid_cursor", recovery_hint: "For the first page omit cursor or use an empty string. For later pages copy next_cursor exactly; do not guess it." }; }
  }
  let fd: number | undefined;
  try {
    fd = openSync(join(input.butlerData, "app-server/message-files", fileId), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== source.originalRef.sizeBytes || stat.size > 10 * 1024 * 1024) throw new Error();
    const bytes = readFileSync(fd);
    if (bytes.byteLength !== stat.size || createHash("sha256").update(bytes).digest("hex") !== source.originalRef.sha256) {
      return { ok: false, error: "source_snapshot_changed" };
    }
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (offset > body.length) return { ok: false, error: "invalid_cursor" };
    let end = Math.min(body.length, offset + 24_000);
    if (end < body.length && /[\uD800-\uDBFF]/u.test(body[end - 1]!)) end--;
    return { ok: true, title: source.title, source: source.source, content: body.slice(offset, end),
      truncated: end < body.length, next_cursor: end < body.length
        ? Buffer.from(JSON.stringify({ fileId, digest: source.originalRef.sha256, offset: end })).toString("base64url") : null };
  } catch { return { ok: false, error: "source_unavailable" }; }
  finally { if (fd !== undefined) closeSync(fd); }
}
