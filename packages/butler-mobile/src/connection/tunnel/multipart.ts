import { concat, utf8 } from "./bytes";

export type MultipartPart = { name: string; value: string } | { name: string; filename: string; type: string; bytes: Uint8Array };

const quoted = (text: string) => text.replace(/["\\\r\n]/g, "_");

export function multipartBody(boundary: string, parts: MultipartPart[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const file = "filename" in part;
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(part.name)}"`
      + (file ? `; filename="${quoted(part.filename)}"\r\nContent-Type: ${part.type}` : "") + "\r\n\r\n";
    chunks.push(utf8(head), file ? part.bytes : utf8(part.value), utf8("\r\n"));
  }
  chunks.push(utf8(`--${boundary}--\r\n`));
  return concat(...chunks);
}
