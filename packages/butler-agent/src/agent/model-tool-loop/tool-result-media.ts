import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type AgentLoopImageAttachment = {
  path: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  name: string;
};

const FIELD = "model_image_attachments";
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export function extractAgentLoopImageAttachments(
  output: unknown,
  toolName: string,
): AgentLoopImageAttachment[] {
  if (toolName !== "inspect_workspace_page") return [];
  if (!record(output) || !Array.isArray(output[FIELD])) return [];
  return output[FIELD].flatMap((value): AgentLoopImageAttachment[] => {
    if (!record(value)) return [];
    const path = relativeArtifactPath(value.path);
    const mediaType = imageMediaType(value.media_type);
    if (!path || !mediaType) return [];
    return [{
      path,
      mediaType,
      name: typeof value.name === "string" && value.name.trim()
        ? value.name.trim().slice(0, 120)
        : "Tool-generated visual evidence",
    }];
  }).slice(0, MAX_IMAGES);
}

export function withoutAgentLoopImageAttachments(output: unknown): unknown {
  if (!record(output) || !(FIELD in output)) return output;
  const copy = { ...output };
  delete copy[FIELD];
  return copy;
}

export function agentLoopImageDataUrl(
  attachment: AgentLoopImageAttachment,
  butlerData: string | undefined,
): string | null {
  if (!butlerData) return null;
  const artifactsRoot = resolve(butlerData, "artifacts", "generated");
  const path = resolve(butlerData, attachment.path);
  const diff = relative(artifactsRoot, path);
  if (
    diff === "" ||
    diff.startsWith("..") ||
    isAbsolute(diff) ||
    !existsSync(path)
  ) return null;
  try {
    const realArtifactsRoot = realpathSync.native(artifactsRoot);
    const realPath = realpathSync.native(path);
    const realDiff = relative(realArtifactsRoot, realPath);
    if (realDiff === "" || realDiff.startsWith("..") || isAbsolute(realDiff)) {
      return null;
    }
    const stat = statSync(realPath);
    if (!stat.isFile() || stat.size < 4 || stat.size > MAX_IMAGE_BYTES) return null;
    const bytes = readFileSync(realPath);
    if (!jpegBytes(bytes)) return null;
    return `data:${attachment.mediaType};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

function relativeArtifactPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || isAbsolute(value)) return null;
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    !/^artifacts\/generated\/page-preview-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:desktop|mobile)-(?:top|bottom)\.jpg$/iu
      .test(normalized) ||
    normalized.split("/").includes("..")
  ) return null;
  return normalized;
}

function jpegBytes(bytes: Buffer): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}

function imageMediaType(
  value: unknown,
): AgentLoopImageAttachment["mediaType"] | null {
  if (value === "image/jpeg") return value;
  return null;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
