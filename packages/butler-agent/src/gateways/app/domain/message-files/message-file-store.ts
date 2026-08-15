import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { AppMessageResponderFile } from "../sessions/message-responder-contract.ts";
import type {
  MessageFileRef,
  MessageFileUploadResult,
} from "../../interface/protocol/app-protocol.ts";
import type { AttachmentRef } from "../../../core/contracts.ts";
import {
  classifyMessageFileKind,
  MESSAGE_FILE_ID_PATTERN,
  MESSAGE_FILE_MAX_ATTACHMENTS,
  MESSAGE_FILE_MAX_BYTES,
  normalizeAttachmentMimeType,
  normalizeFileBytes,
  safeAttachmentName,
} from "./message-file-storage.ts";
import {
  getMessageFileRow,
  artifactRevisionForSession,
  countSessionMessageFileRows,
  listMessageAttachmentRows,
  listMessageAttachmentRowsForMessages,
  listQueuedMessageFileRows,
  listSessionMessageFileRows,
  type MessageFileRow,
} from "./message-file-records.ts";
import { messageFileRefFromRow } from "../sessions/message-read-model.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import {
  admitVisualImageRequest,
  assertVisualCarrierMatchesCatalog,
  defaultImageSanitizer,
  imageAdmissionForCatalogEntry,
  sha256,
  verifyVisualManifestSource,
  visualDerivativeStorageName,
  type VisualImageAdmissionResult,
  ImageAdmissionError,
  type ImageCapabilityCatalogEntry,
  type VerifiedImagePayloadPort,
  type VisualCapabilityResolver,
  type VisualAdmittedManifest,
} from "../../../../agent/image-attachment/index.ts";

export type { MessageFileRow } from "./message-file-records.ts";

export class AppMessageFileStore {
  constructor(
    private readonly db: Database,
    private readonly butlerData: string,
    private readonly ensureOwnerSession: (sessionId: string) => void,
    private readonly visualCapabilityResolver: VisualCapabilityResolver = {
      resolve: async ({ entry }) => entry,
    },
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
    return getMessageFileRow(this.db, fileId);
  }

  queuedRows(row: { attachments_json: string }): MessageFileRow[] {
    return listQueuedMessageFileRows(this.db, row);
  }

  refsForMessage(messageId: string): MessageFileRef[] {
    return this.attachmentRows(messageId).map(messageFileRefFromRow);
  }

  refsForMessages(messageIds: readonly string[]): Map<string, MessageFileRef[]> {
    const rowsByMessage = listMessageAttachmentRowsForMessages(
      this.db,
      messageIds,
    );
    return new Map(
      [...rowsByMessage].map(([messageId, rows]) => [
        messageId,
        rows.map(messageFileRefFromRow),
      ]),
    );
  }

  attachmentsForTransport(
    messageId: string,
    admission?: VisualImageAdmissionResult,
  ): AttachmentRef[] {
    return this.attachmentRows(messageId).map((row) => {
      const visual = row.kind === "image"
        ? admission?.manifests.find((manifest) => manifest.fileId === row.id)
        : undefined;
      if (row.kind === "image" && !visual) {
        throw new AppStoreOperationError(
          409,
          "image_admission_missing",
          "Image attachment admission is missing.",
        );
      }
      return {
        id: row.id,
        kind:
          row.kind === "image" ? "image" : row.kind === "text" ? "document" : "binary",
        mimeType: row.mime_type,
        fileName: row.safe_name,
        sizeBytes: row.size_bytes,
        ...(row.kind === "image"
          ? { visualManifest: visual }
          : { localPath: resolve(this.root(), row.storage_name) }),
        url: `/message-files/${encodeURIComponent(row.id)}`,
        metadata: {
          source: "message-file-store",
          createdAt: row.created_at,
        },
      };
    });
  }

  /**
   * Admission runs before either the durable session queue or message/Turn
   * insert. It validates the selected exact catalog tuple and writes only the
   * sanitized derivative after the tuple has passed.
   */
  admitVisualAttachments(
    files: readonly MessageFileRow[],
    model: string,
    catalog: readonly ImageCapabilityCatalogEntry[],
  ): Promise<VisualImageAdmissionResult | undefined> {
    const images = files.filter((file) => file.kind === "image");
    if (images.length === 0) return Promise.resolve(undefined);
    const entry = catalog.find((candidate) =>
      candidate.model_ref === model || candidate.model_id === model,
    );
    return this.visualCapabilityResolver.resolve({
      entry,
      modelRef: model,
      butlerData: this.butlerData,
    }).then((resolvedEntry) => Promise.all(images.map((file, position) =>
      this.prepareVisualDerivative(file, position),
    )).then((prepared) => {
      let result: VisualImageAdmissionResult;
      try {
        result = imageAdmissionForCatalogEntry(
          resolvedEntry,
          prepared.map((item) => item.manifest),
        );
      } catch (error) {
        throw imageAdmissionErrorToAppError(error);
      }
      prepared.forEach((item) => this.persistVisualDerivative(item.manifest, item.bytes));
      return result;
    })).catch((error) => {
      if (error instanceof AppStoreOperationError) throw error;
      throw imageAdmissionErrorToAppError(error);
    });
  }

  async validateVisualAdmission(
    admission: VisualImageAdmissionResult,
    model: string,
    catalog: readonly ImageCapabilityCatalogEntry[],
  ): Promise<VisualImageAdmissionResult> {
    const entry = catalog.find((candidate) =>
      candidate.model_ref === model || candidate.model_id === model,
    );
    return this.visualCapabilityResolver.resolve({
      entry,
      modelRef: model,
      butlerData: this.butlerData,
    }).then((resolvedEntry) => {
      try {
      const route = {
        providerId: resolvedEntry?.provider_id ?? "",
        modelId: resolvedEntry?.model_id ?? "",
        carrierProtocol: resolvedEntry?.image_carrier_protocol ??
          (resolvedEntry?.hosted_api_shape === "openai_responses"
            ? "openai_responses"
            : resolvedEntry?.hosted_api_shape === "openai_chat_completions"
              ? "openai_chat_completions"
              : "fake_vision"),
        endpointProfileId: resolvedEntry?.image_endpoint_profile_id ?? "",
        catalogCapabilityRevision: resolvedEntry?.image_capability_revision ?? "",
        catalogCapabilityDigest: resolvedEntry?.image_capability_digest ?? "",
      } as const;
      assertVisualCarrierMatchesCatalog({
        catalogEntry: resolvedEntry,
        tuple: admission.tuple,
        capability: admission.capability,
        resolvedRoute: route,
      });
      const checked = admitVisualImageRequest({
        tuple: admission.tuple,
        capability: admission.capability,
        manifests: admission.manifests,
      });
      for (const manifest of checked.manifests) {
        const row = this.row(manifest.fileId);
        if (!row || row.kind !== "image") {
          throw new ImageAdmissionError("image_payload_invalid", "source_row_missing");
        }
        const sourceBytes = Uint8Array.from(readFileSync(resolve(this.root(), row.storage_name)));
        verifyVisualManifestSource({
          manifest,
          sourceBytes,
          sourceRecord: {
            sizeBytes: row.size_bytes,
            sha256: row.sha256,
            storageRevision: `${row.created_at}:${row.sha256}`,
          },
        });
        const derivativeBytes = Uint8Array.from(readFileSync(this.visualPath(manifest)));
        if (derivativeBytes.byteLength !== manifest.derivativeSizeBytes ||
            sha256(derivativeBytes) !== manifest.derivativeDigest) {
          throw new ImageAdmissionError("image_payload_invalid", "derivative_digest_mismatch");
        }
      }
      return checked;
      } catch (error) {
        throw imageAdmissionErrorToAppError(error);
      }
    });
  }

  verifiedImagePayloadPort(): VerifiedImagePayloadPort {
    return {
      read: async (manifest) => {
        const bytes = readFileSync(this.visualPath(manifest));
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== manifest.derivativeDigest) {
          throw new AppStoreOperationError(
            409,
            "image_payload_tampered",
            "Image attachment could not be verified.",
          );
        }
        return { bytes: Uint8Array.from(bytes), mimeType: manifest.derivativeMimeType };
      },
    };
  }

  refsForSession(sessionId: string): MessageFileRef[] {
    return listSessionMessageFileRows(this.db, sessionId).map(
      messageFileRefFromRow,
    );
  }

  countForSession(sessionId: string): number {
    return countSessionMessageFileRows(this.db, sessionId);
  }

  artifactRevision(sessionId: string): string {
    return artifactRevisionForSession(this.db, sessionId);
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

  private visualPath(manifest: Pick<VisualAdmittedManifest, "fileId" | "derivativeDigest">): string {
    return join(this.root(), visualDerivativeStorageName(manifest));
  }

  private async prepareVisualDerivative(
    row: MessageFileRow,
    position: number,
  ): Promise<{ manifest: VisualAdmittedManifest; bytes: Uint8Array }> {
    const bytes = Uint8Array.from(readFileSync(resolve(this.root(), row.storage_name)));
    if (bytes.byteLength !== row.size_bytes || sha256(bytes) !== row.sha256) {
      throw new AppStoreOperationError(409, "image_source_tampered", "Image attachment could not be verified.");
    }
    const storageRevision = `${row.created_at}:${row.sha256}`;
    try {
      const prepared = await defaultImageSanitizer.sanitize({
        fileId: row.id,
        safeName: row.safe_name,
        mimeType: row.mime_type,
        sourceBytes: bytes,
        storageRevision,
        position,
      });
      verifyVisualManifestSource({
        manifest: prepared.manifest,
        sourceBytes: bytes,
        sourceRecord: {
          sizeBytes: row.size_bytes,
          sha256: row.sha256,
          storageRevision,
        },
      });
      return prepared;
    } catch (error) {
      throw imageAdmissionErrorToAppError(error);
    }
  }

  private persistVisualDerivative(manifest: VisualAdmittedManifest, bytes: Uint8Array): void {
    mkdirSync(this.root(), { recursive: true });
    const path = this.visualPath(manifest);
    if (existsSync(path)) {
      const existing = Uint8Array.from(readFileSync(path));
      if (existing.byteLength !== bytes.byteLength || sha256(existing) !== manifest.derivativeDigest) {
        throw new AppStoreOperationError(409, "image_derivative_conflict", "Image derivative identity conflict.");
      }
      return;
    }
    writeFileSync(path, bytes, { flag: "wx" });
  }

  private attachmentRows(messageId: string): MessageFileRow[] {
    return listMessageAttachmentRows(this.db, messageId);
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

}

function imageAdmissionErrorToAppError(
  error: unknown,
): AppStoreOperationError {
  if (error instanceof AppStoreOperationError) return error;
  if (error instanceof ImageAdmissionError) {
    const status = error.code === "image_payload_invalid"
      ? 413
      : error.code === "image_manifest_invalid"
        ? 422
        : 409;
    const message = error.code === "image_model_unsupported"
      ? "현재 모델은 이미지를 읽을 수 없습니다. 이미지 지원 모델을 선택하거나 이미지를 제거하세요."
      : error.code === "image_capability_unknown"
        ? "현재 모델의 이미지 지원 여부를 확인할 수 없습니다. 모델 설정을 확인하거나 이미지를 제거하세요."
      : error.code === "image_carrier_unavailable"
        ? "현재 모델로 이미지를 전송할 수 있는 어댑터가 없습니다. 모델 연결 설정을 확인하세요."
      : error.code === "image_route_incompatible"
        ? "현재 모델 연결 경로는 이미지 입력과 호환되지 않습니다. 연결 설정을 확인하세요."
      : error.code === "image_carrier_unverified"
        ? "이미지 전송 경로를 확인할 수 없습니다."
        : "이미지 첨부를 확인할 수 없습니다.";
    return new AppStoreOperationError(status, error.code, message);
  }
  return new AppStoreOperationError(422, "image_payload_invalid", "이미지 첨부를 처리할 수 없습니다.");
}
