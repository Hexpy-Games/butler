/** Uploaded browser element draft references; crops stay in message-file storage. */
export interface ElementFileRef {
  file_id: string; kind: "image" | "text" | "generic"; mime_type: string; safe_name: string;
  size_bytes: number; sha256: string; url: string; signed_url?: string; created_at: string;
}
export interface ElementAttachment {
  id: string; title: string; site: string; file: ElementFileRef; crop: ElementFileRef;
}
