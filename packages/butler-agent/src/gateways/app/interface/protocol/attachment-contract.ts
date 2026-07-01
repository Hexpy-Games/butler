import type { MessageFileKind } from "./base-contract.ts";

export interface MessageFileRef {
  file_id: string;
  kind: MessageFileKind;
  mime_type: string;
  safe_name: string;
  size_bytes: number;
  sha256: string;
  url: string;
  created_at: string;
}

export interface MessageFileUploadResult {
  file: MessageFileRef;
}

export interface MessageAttachmentInput {
  file_id: string;
}

export interface SessionArtifactSummary {
  id: string;
  session_id?: string;
  project_id?: string;
  message_id?: string;
  turn_id?: string;
  file_id?: string;
  kind:
    | "csv_file"
    | "table_file"
    | "chart_file"
    | "image"
    | "document"
    | "code"
    | "report"
    | "file"
    | "unknown";
  title: string;
  safe_path_label?: string;
  url?: string;
  size_bytes?: number;
  created_at: string;
  open_action?: "route" | "unsupported";
}
