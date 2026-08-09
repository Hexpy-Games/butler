import { ImageAdmissionError, type VerifiedImagePayloadPort, type VisualAdmittedManifest } from "./contracts.ts";
import { sha256 } from "./sanitizer.ts";

export async function serializeOpenAIVisualInput(input: {
  text: string;
  manifests: readonly VisualAdmittedManifest[];
  payloadPort: VerifiedImagePayloadPort;
}): Promise<Array<{ role: "user"; content: Array<Record<string, unknown>> }>> {
  const content: Array<Record<string, unknown>> = [];
  if (input.text.trim()) content.push({ type: "input_text", text: input.text });
  for (const manifest of [...input.manifests].sort((left, right) => left.position - right.position)) {
    const payload = await input.payloadPort.read(manifest);
    if (!payload.bytes.length || payload.bytes.byteLength !== manifest.derivativeSizeBytes ||
        payload.mimeType !== manifest.derivativeMimeType) {
      throw new ImageAdmissionError("image_payload_invalid", "payload_manifest_mismatch");
    }
    if (sha256(payload.bytes) !== manifest.derivativeDigest) {
      throw new ImageAdmissionError("image_payload_invalid", "payload_digest_mismatch");
    }
    content.push({
      type: "input_image",
      image_url: `data:${payload.mimeType};base64,${Buffer.from(payload.bytes).toString("base64")}`,
    });
  }
  return [{ role: "user", content }];
}
