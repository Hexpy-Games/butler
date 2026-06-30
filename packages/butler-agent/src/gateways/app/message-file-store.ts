import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { AppMessageResponderFile } from "./message-responder-contract.ts";
import type {
  MessageFileKind,
  MessageFileRef,
  MessageFileUploadResult,
} from "./protocol.ts";
import type { AttachmentRef } from "../core/contracts.ts";
import {
  classifyMessageFileKind,
  MESSAGE_FILE_ID_PATTERN,
  MESSAGE_FILE_MAX_ATTACHMENTS,
  MESSAGE_FILE_MAX_BYTES,
  normalizeAttachmentMimeType,
  normalizeFileBytes,
  safeAttachmentName,
} from "./message-file-storage.ts";
import { messageFileRefFromRow } from "./message-read-model.ts";
import { AppStoreOperationError } from "./app-store-errors.ts";

export interface MessageFileRow {
  id: string;
  owner_session_id: string | null;
  message_id: string | null;
  kind: MessageFileKind;
  mime_type: string;
  safe_name: string;
  size_bytes: number;
  sha256: string;
  storage_name: string;
  created_at: string;
}

export class AppMessageFileStore {
  constructor(
    private readonly db: Database,
    private readonly butlerData: string,
    private readonly ensureOwnerSession: (sessionId: string) => void,
  ) {}

  create(input: {
    ownerSessionId?: string;
    name: string;
    mimeType?: string;
    bytes: Uint8Array | ArrayBuffer | string;
    allowGeneric?: boolean;
  }): MessageFileUploadResult {
    const ownerSessionId = input.ownerSessionId?.trim() || null;
    if (ownerSessionId) this.ensureOwnerSession(ownerSessionId);
    const bytes = normalizeFileBytes(input.bytes);
    this.assertUploadSize(bytes.byteLength);
    const safeName = safeAttachmentName(input.name);
    const mimeType = normalizeAttachmentMimeType(input.mimeType, safeName);
    const kind = classifyMessageFileKind(
      mimeType,
      safeName,
      Boolean(input.allowGeneric),
    );
    if (!kind) {
      throw new AppStoreOperationError(
        415,
        "message_file_unsupported_type",
        "Attachment file type is not supported.",
      );
    }
    const id = `file-${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    mkdirSync(this.root(), { recursive: true });
    writeFileSync(join(this.root(), id), bytes);
    this.db
      .query(
        `
      INSERT INTO message_files (
        id, owner_session_id, message_id, kind, mime_type, safe_name,
        size_bytes, sha256, storage_name, created_at
      )
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(id, ownerSessionId, kind, mimeType, safeName, bytes.byteLength, sha256, id, createdAt);
    const row = this.row(id);
    if (!row) throw new Error(`Failed to create message file: ${id}`);
    return { file: messageFileRefFromRow(row) };
  }

  download(fileId: string): { file: MessageFileRef; bytes: Buffer } {
    const row = this.requireDownloadableRow(fileId);
    return {
      file: messageFileRefFromRow(row),
      bytes: readFileSync(resolve(this.root(), row.storage_name)),
    };
  }

  row(fileId: string): MessageFileRow | null {
    if (!MESSAGE_FILE_ID_PATTERN.test(fileId)) return null;
    return (
      this.db
        .query<MessageFileRow, [string]>(
          `
      SELECT id, owner_session_id, message_id, kind, mime_type, safe_name,
        size_bytes, sha256, storage_name, created_at
      FROM message_files
      WHERE id = ?
    `,
        )
        .get(fileId) ?? null
    );
  }

  queuedRows(row: { attachments_json: string }): MessageFileRow[] {
    return this.attachmentIdsFromJson(row.attachments_json)
      .map((fileId) => this.row(fileId))
      .filter((file): file is MessageFileRow => Boolean(file));
  }

  refsForMessage(messageId: string): MessageFileRef[] {
    return this.attachmentRows(messageId).map(messageFileRefFromRow);
  }

  attachmentsForTransport(messageId: string): AttachmentRef[] {
    return this.attachmentRows(messageId).map((row) => ({
      id: row.id,
      kind:
        row.kind === "image" ? "image" : row.kind === "text" ? "document" : "binary",
      mimeType: row.mime_type,
      fileName: row.safe_name,
      sizeBytes: row.size_bytes,
      localPath: resolve(this.root(), row.storage_name),
      url: `/message-files/${encodeURIComponent(row.id)}`,
      metadata: {
        source: "message-file-store",
        createdAt: row.created_at,
      },
    }));
  }

  refsForSession(sessionId: string): MessageFileRef[] {
    const rows = this.db
      .query<MessageFileRow, [string]>(
        `
      SELECT id, owner_session_id, message_id, kind, mime_type, safe_name,
        size_bytes, sha256, storage_name, created_at
      FROM message_files
      WHERE owner_session_id = ?
      ORDER BY created_at ASC
    `,
      )
      .all(sessionId);
    return rows.map(messageFileRefFromRow);
  }

  validateAttachable(
    chatId: string,
    attachments: Array<{ file_id?: string }>,
  ): MessageFileRow[] {
    const ids = Array.from(
      new Set(
        attachments
          .map((attachment) => attachment?.file_id?.trim() ?? "")
          .filter(Boolean),
      ),
    );
    if (ids.length > MESSAGE_FILE_MAX_ATTACHMENTS) {
      throw new AppStoreOperationError(
        400,
        "too_many_attachments",
        "Too many attachments.",
      );
    }
    return ids.map((fileId) => this.requireAttachable(chatId, fileId));
  }

  attachToMessage(
    chatId: string,
    messageId: string,
    files: MessageFileRow[],
  ): void {
    files.forEach((file, index) => {
      this.db
        .query(
          `
        INSERT OR REPLACE INTO message_attachments (message_id, file_id, position)
        VALUES (?, ?, ?)
      `,
        )
        .run(messageId, file.id, index);
      this.db
        .query(
          `
        UPDATE message_files
        SET owner_session_id = ?, message_id = ?
        WHERE id = ?
      `,
        )
        .run(chatId, messageId, file.id);
    });
  }

  createResponderFiles(
    chatId: string,
    files: AppMessageResponderFile[],
  ): MessageFileRow[] {
    return files.slice(0, MESSAGE_FILE_MAX_ATTACHMENTS).map((file) => {
      const created = this.create({
        ownerSessionId: chatId,
        name: file.name,
        mimeType: file.mimeType,
        bytes: file.bytes,
        allowGeneric: true,
      });
      const row = this.row(created.file.file_id);
      if (!row) {
        throw new Error(`Failed to load responder file: ${created.file.file_id}`);
      }
      return row;
    });
  }

  private root(): string {
    return resolve(this.butlerData, "app-server", "message-files");
  }

  private attachmentRows(messageId: string): MessageFileRow[] {
    return this.db
      .query<MessageFileRow, [string]>(
        `
      SELECT f.id, f.owner_session_id, f.message_id, f.kind, f.mime_type,
        f.safe_name, f.size_bytes, f.sha256, f.storage_name, f.created_at
      FROM message_attachments a
      JOIN message_files f ON f.id = a.file_id
      WHERE a.message_id = ?
      ORDER BY a.position ASC
    `,
      )
      .all(messageId);
  }

  private requireAttachable(chatId: string, fileId: string): MessageFileRow {
    const row = this.row(fileId);
    if (!row) {
      throw new AppStoreOperationError(
        400,
        "message_file_not_found",
        "Attachment file not found.",
      );
    }
    if (row.message_id) {
      throw new AppStoreOperationError(
        409,
        "message_file_already_attached",
        "Attachment file was already sent.",
      );
    }
    if (row.owner_session_id && row.owner_session_id !== chatId) {
      throw new AppStoreOperationError(
        403,
        "message_file_wrong_session",
        "Attachment file belongs to a different session.",
      );
    }
    return row;
  }

  private requireDownloadableRow(fileId: string): MessageFileRow {
    const row = this.row(fileId);
    if (
      !row ||
      row.storage_name !== row.id ||
      !MESSAGE_FILE_ID_PATTERN.test(row.storage_name)
    ) {
      throw new AppStoreOperationError(
        404,
        "message_file_not_found",
        "Attachment file not found.",
      );
    }
    const filePath = resolve(this.root(), row.storage_name);
    if (!filePath.startsWith(`${this.root()}${sep}`)) {
      throw new AppStoreOperationError(
        404,
        "message_file_not_found",
        "Attachment file not found.",
      );
    }
    return row;
  }

  private assertUploadSize(byteLength: number): void {
    if (byteLength === 0) {
      throw new AppStoreOperationError(
        400,
        "message_file_empty",
        "Attachment file is empty.",
      );
    }
    if (byteLength > MESSAGE_FILE_MAX_BYTES) {
      throw new AppStoreOperationError(
        413,
        "message_file_too_large",
        "Attachment file is too large.",
      );
    }
  }

  private attachmentIdsFromJson(value: string): string[] {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => (typeof item === "string" ? item : ""))
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}
