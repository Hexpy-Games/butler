import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ImageAdmissionError, type VerifiedImagePayloadPort, type VisualAdmittedManifest } from "../contracts.ts";

/** Content-addressed derivative storage name; an admitted derivative is never overwritten. */
export function visualDerivativeStorageName(manifest: Pick<VisualAdmittedManifest, "fileId" | "derivativeDigest">): string {
  return `${manifest.fileId}.visual.${manifest.derivativeDigest}`;
}

export function createFileStoreVerifiedImagePayloadPort(
  butlerData: string,
): VerifiedImagePayloadPort {
  return {
    async read(manifest) {
      const fileId = manifest.fileId.trim();
      if (!/^file-[0-9a-f-]{36}$/iu.test(fileId) || !/^[0-9a-f]{64}$/u.test(manifest.derivativeDigest)) {
        throw new ImageAdmissionError("image_payload_invalid", "file_identity_invalid");
      }
      const root = resolve(butlerData, "app-server", "message-files");
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(readFileSync(join(root, visualDerivativeStorageName(manifest))));
      } catch {
        throw new ImageAdmissionError("image_payload_invalid", "derivative_missing");
      }
      if (bytes.byteLength !== manifest.derivativeSizeBytes) {
        throw new ImageAdmissionError("image_payload_invalid", "payload_size_mismatch");
      }
      if (createHash("sha256").update(bytes).digest("hex") !== manifest.derivativeDigest) {
        throw new ImageAdmissionError("image_payload_invalid", "payload_digest_mismatch");
      }
      return { bytes, mimeType: manifest.derivativeMimeType };
    },
  };
}
