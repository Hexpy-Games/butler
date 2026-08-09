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
    content.push({
      type: "input_image",
      image_url: await verifiedImageDataUrl(manifest, input.payloadPort),
    });
  }
  return [{ role: "user", content }];
}

export async function serializeOpenAIChatVisualContent(input: {
  text: string;
  manifests: readonly VisualAdmittedManifest[];
  payloadPort: VerifiedImagePayloadPort;
}): Promise<Array<Record<string, unknown>>> {
  const content: Array<Record<string, unknown>> = [];
  if (input.text.trim()) content.push({ type: "text", text: input.text });
  for (const manifest of [...input.manifests].sort((left, right) => left.position - right.position)) {
    content.push({
      type: "image_url",
      image_url: { url: await verifiedImageDataUrl(manifest, input.payloadPort) },
    });
  }
  return content;
}

async function verifiedImageDataUrl(
  manifest: VisualAdmittedManifest,
  payloadPort: VerifiedImagePayloadPort,
): Promise<string> {
  const payload = await payloadPort.read(manifest);
  if (!payload.bytes.length || payload.bytes.byteLength !== manifest.derivativeSizeBytes ||
      payload.mimeType !== manifest.derivativeMimeType) {
    throw new ImageAdmissionError("image_payload_invalid", "payload_manifest_mismatch");
  }
  if (sha256(payload.bytes) !== manifest.derivativeDigest) {
    throw new ImageAdmissionError("image_payload_invalid", "payload_digest_mismatch");
  }
  return `data:${payload.mimeType};base64,${Buffer.from(payload.bytes).toString("base64")}`;
}
