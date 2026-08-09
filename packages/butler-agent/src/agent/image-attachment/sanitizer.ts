import { createHash } from "node:crypto";
import {
  ImageAdmissionError,
  type ImageSourceRecord,
  type ImageSanitizedResult,
  type ImageSanitizerInput,
  type VisualAdmittedManifest,
} from "./contracts.ts";

export const IMAGE_SANITIZER_REVISION = "visual-derivative-sharp-v1";

const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
  0xce, 0xcf,
]);

export type SniffedImage = {
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  magic: "png" | "jpeg" | "gif" | "webp";
};

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  ) >>> 0;
}

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length >= 8 && equalBytes(bytes.slice(0, 8), PNG_SIGNATURE)) {
    return { mimeType: "image/png", magic: "png" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { mimeType: "image/jpeg", magic: "jpeg" };
  }
  const gifHeader = bytes.length >= 6 ? readAscii(bytes, 0, 6) : "";
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
    return { mimeType: "image/gif", magic: "gif" };
  }
  if (bytes.length >= 12 && readAscii(bytes, 0, 4) === "RIFF" && readAscii(bytes, 8, 4) === "WEBP") {
    return { mimeType: "image/webp", magic: "webp" };
  }
  return null;
}

export function imageDimensions(
  sniffed: SniffedImage,
  bytes: Uint8Array,
): { width: number; height: number } {
  if (sniffed.magic === "png" && bytes.length >= 24) {
    return { width: readUint32(bytes, 16), height: readUint32(bytes, 20) };
  }
  if (sniffed.magic === "gif" && bytes.length >= 10) {
    return {
      width: (bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8),
      height: (bytes[8] ?? 0) | ((bytes[9] ?? 0) << 8),
    };
  }
  if (sniffed.magic === "webp" && bytes.length >= 30) {
    const chunk = readAscii(bytes, 12, 4);
    if (chunk === "VP8X") {
      const width = 1 + (bytes[24] ?? 0) + ((bytes[25] ?? 0) << 8) + ((bytes[26] ?? 0) << 16);
      const height = 1 + (bytes[27] ?? 0) + ((bytes[28] ?? 0) << 8) + ((bytes[29] ?? 0) << 16);
      return { width, height };
    }
  }
  if (sniffed.magic === "jpeg") {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (marker === 0xda) break;
      const segmentLength = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      if (JPEG_SOF_MARKERS.has(marker)) {
        return {
          height: ((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0),
          width: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0),
        };
      }
      offset += segmentLength;
    }
  }
  return { width: 0, height: 0 };
}

export function assertMagic(mimeType: string, bytes: Uint8Array): SniffedImage {
  const sniffed = sniffImage(bytes);
  if (!sniffed) {
    throw new ImageAdmissionError("image_manifest_invalid", "magic_unrecognized");
  }
  if (sniffed.mimeType !== mimeType.toLowerCase()) {
    throw new ImageAdmissionError("image_manifest_invalid", "magic_mime_mismatch");
  }
  return sniffed;
}

function manifestDigest(manifest: Omit<VisualAdmittedManifest, "manifestDigest">): string {
  return sha256(new TextEncoder().encode(JSON.stringify(manifest)));
}

export function createVisualManifest(input: {
  fileId: string;
  safeName: string;
  mimeType: string;
  sourceBytes: Uint8Array;
  derivativeBytes: Uint8Array;
  derivativeMimeType?: string;
  storageRevision?: string;
  position: number;
}): VisualAdmittedManifest {
  if (input.sourceBytes.length === 0 || input.derivativeBytes.length === 0) {
    throw new ImageAdmissionError("image_manifest_invalid", "empty_payload");
  }
  const sourceBytes = Uint8Array.from(input.sourceBytes);
  const derivativeBytes = Uint8Array.from(input.derivativeBytes);
  const sniffed = assertMagic(input.mimeType, sourceBytes);
  const derivativeMimeType = (input.derivativeMimeType ?? input.mimeType).toLowerCase();
  const derivativeSniffed = assertMagic(derivativeMimeType, derivativeBytes);
  const dimensions = imageDimensions(derivativeSniffed, derivativeBytes);
  if (dimensions.width <= 0 || dimensions.height <= 0) {
    throw new ImageAdmissionError("image_manifest_invalid", "dimensions_unavailable");
  }
  const sourceDigest = sha256(sourceBytes);
  const derivativeDigest = sha256(derivativeBytes);
  const manifestWithoutDigest: Omit<VisualAdmittedManifest, "manifestDigest"> = {
    kind: "image",
    fileId: input.fileId,
    position: input.position,
    safeName: input.safeName,
    mimeType: input.mimeType.toLowerCase(),
    sniffedMimeType: sniffed.mimeType,
    sniffedMagic: sniffed.magic,
    storageRevision: input.storageRevision?.trim() || "message-file-row-v1",
    sourceSizeBytes: sourceBytes.length,
    sourceDigest,
    derivativeId: `${input.fileId}:visual:${IMAGE_SANITIZER_REVISION}:${derivativeDigest}`,
    derivativeMimeType,
    derivativeSizeBytes: derivativeBytes.length,
    derivativeDigest,
    width: dimensions.width,
    height: dimensions.height,
    pixelCount: dimensions.width * dimensions.height,
    sanitizerRevision: IMAGE_SANITIZER_REVISION,
  };
  return {
    ...manifestWithoutDigest,
    manifestDigest: manifestDigest(manifestWithoutDigest),
  };
}

export function verifyVisualManifestSource(input: {
  manifest: VisualAdmittedManifest;
  sourceBytes: Uint8Array;
  sourceRecord: ImageSourceRecord;
}): void {
  const { manifest, sourceBytes, sourceRecord } = input;
  if (sourceBytes.byteLength !== sourceRecord.sizeBytes ||
      sourceBytes.byteLength !== manifest.sourceSizeBytes ||
      sha256(sourceBytes) !== sourceRecord.sha256 ||
      sha256(sourceBytes) !== manifest.sourceDigest ||
      sourceRecord.storageRevision !== manifest.storageRevision) {
    throw new ImageAdmissionError("image_payload_invalid", "source_record_mismatch");
  }
  const sniffed = sniffImage(sourceBytes);
  if (!sniffed || sniffed.mimeType !== manifest.sniffedMimeType || sniffed.magic !== manifest.sniffedMagic) {
    throw new ImageAdmissionError("image_payload_invalid", "source_magic_mismatch");
  }
}

export function freezeVisualManifest(manifest: VisualAdmittedManifest): VisualAdmittedManifest {
  return Object.freeze(manifest);
}

export function assertSanitizerLimits(
  input: ImageSanitizerInput,
  manifest: VisualAdmittedManifest,
): void {
  const limits = input.limits;
  if (limits?.maxBytes !== undefined && manifest.sourceSizeBytes > limits.maxBytes) {
    throw new ImageAdmissionError("image_payload_invalid", "image_limit_exceeded");
  }
  if (limits?.maxWidth !== undefined && manifest.width > limits.maxWidth) {
    throw new ImageAdmissionError("image_payload_invalid", "image_limit_exceeded");
  }
  if (limits?.maxHeight !== undefined && manifest.height > limits.maxHeight) {
    throw new ImageAdmissionError("image_payload_invalid", "image_limit_exceeded");
  }
  if (limits?.maxPixels !== undefined && manifest.pixelCount > limits.maxPixels) {
    throw new ImageAdmissionError("image_payload_invalid", "image_limit_exceeded");
  }
}

export function freezeSanitizedResult(result: ImageSanitizedResult): ImageSanitizedResult {
  return Object.freeze({
    manifest: freezeVisualManifest(result.manifest),
    bytes: Uint8Array.from(result.bytes),
  });
}
