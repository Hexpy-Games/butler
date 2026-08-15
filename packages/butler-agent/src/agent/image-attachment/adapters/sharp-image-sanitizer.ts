import sharp from "sharp";
import {
  ImageAdmissionError,
  type ImageSanitizerPort,
  type ImageSanitizedResult,
  type ImageSanitizerInput,
} from "../contracts.ts";
import {
  assertMagic,
  assertSanitizerLimits,
  createVisualManifest,
  freezeSanitizedResult,
  IMAGE_SANITIZER_REVISION,
} from "../sanitizer.ts";

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_WIDTH = 16_384;
const DEFAULT_MAX_HEIGHT = 16_384;
const DEFAULT_MAX_PIXELS = 64_000_000;

/**
 * Decode and re-encode every accepted visual format.  Sharp's output
 * encoders omit metadata by default, which removes EXIF/ICC/XMP payloads;
 * animated GIFs intentionally use the first frame and become PNG derivatives.
 */
export function createSharpImageSanitizer(): ImageSanitizerPort {
  return {
    async sanitize(input: ImageSanitizerInput): Promise<ImageSanitizedResult> {
      const sourceBytes = Uint8Array.from(input.sourceBytes);
      if (sourceBytes.length === 0) {
        throw new ImageAdmissionError("image_manifest_invalid", "empty_source");
      }
      if (sourceBytes.length > Math.min(input.limits?.maxBytes ?? MAX_SOURCE_BYTES, MAX_SOURCE_BYTES)) {
        throw new ImageAdmissionError("image_payload_invalid", "image_limit_exceeded");
      }
      const sniffed = assertMagic(input.mimeType.toLowerCase(), sourceBytes);
      let metadata: sharp.Metadata;
      try {
        metadata = await sharp(sourceBytes, {
          ...(sniffed.magic === "gif" ? { pages: 1, page: 0 } : {}),
          failOn: "error",
        }).metadata();
      } catch (error) {
        throw new ImageAdmissionError(
          "image_payload_invalid",
          `preprocess_failed:${error instanceof Error ? error.message : "decode_failed"}`,
        );
      }
      const width = metadata.width ?? 0;
      const height = metadata.height ?? 0;
      if (width <= 0 || height <= 0 || width > DEFAULT_MAX_WIDTH || height > DEFAULT_MAX_HEIGHT ||
          width * height > DEFAULT_MAX_PIXELS) {
        throw new ImageAdmissionError("image_payload_invalid", "image_limit_exceeded");
      }
      const maxWidth = input.limits?.maxWidth ?? DEFAULT_MAX_WIDTH;
      const maxHeight = input.limits?.maxHeight ?? DEFAULT_MAX_HEIGHT;
      const maxPixels = input.limits?.maxPixels ?? DEFAULT_MAX_PIXELS;
      if (width > maxWidth || height > maxHeight || width * height > maxPixels) {
        throw new ImageAdmissionError("image_payload_invalid", "image_limit_exceeded");
      }

      try {
        const image = sharp(sourceBytes, {
          ...(sniffed.magic === "gif" ? { pages: 1, page: 0 } : {}),
          failOn: "error",
        }).rotate();
        let derivativeBytes: Buffer;
        let derivativeMimeType: string;
        switch (sniffed.magic) {
          case "jpeg":
            derivativeBytes = await image.jpeg({ quality: 90, mozjpeg: false }).toBuffer();
            derivativeMimeType = "image/jpeg";
            break;
          case "png":
            derivativeBytes = await image.png({ compressionLevel: 9 }).toBuffer();
            derivativeMimeType = "image/png";
            break;
          case "webp":
            derivativeBytes = await image.webp({ quality: 90 }).toBuffer();
            derivativeMimeType = "image/webp";
            break;
          case "gif":
            derivativeBytes = await image.png({ compressionLevel: 9 }).toBuffer();
            derivativeMimeType = "image/png";
            break;
        }
        const manifest = createVisualManifest({
          fileId: input.fileId,
          safeName: input.safeName,
          mimeType: input.mimeType,
          sourceBytes,
          derivativeBytes,
          derivativeMimeType,
          storageRevision: input.storageRevision,
          position: input.position,
        });
        assertSanitizerLimits(input, manifest);
        // Keep the revision explicit in the identity even if a future encoder
        // changes its default output options.
        if (manifest.sanitizerRevision !== IMAGE_SANITIZER_REVISION) {
          throw new ImageAdmissionError("image_manifest_invalid", "sanitizer_revision_invalid");
        }
        return freezeSanitizedResult({ manifest, bytes: derivativeBytes });
      } catch (error) {
        if (error instanceof ImageAdmissionError) throw error;
        throw new ImageAdmissionError(
          "image_payload_invalid",
          `preprocess_failed:${error instanceof Error ? error.message : "encode_failed"}`,
        );
      }
    },
  };
}

export const defaultImageSanitizer = createSharpImageSanitizer();
