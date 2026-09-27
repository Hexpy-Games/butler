import { appCopy } from "@/app/copy.ts";
import type { AppModelSummary } from "@/app/types.ts";

/** The gateway's image kinds (message_file_store `kind`): other image/* files are ordinary files. */
const GATEWAY_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const IMAGE_EXTENSION_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
};
/** GIF is re-encoded as PNG by the gateway before admission. */
const DERIVATIVE_MIME: Record<string, string> = { "image/gif": "image/png" };
/**
 * `accept` cannot exclude types, so a text-only picker lists everything else:
 * non-image MIME families plus common document and code extensions.
 */
const NON_IMAGE_ACCEPT = [
  "text/*", "application/*", "audio/*", "video/*", "font/*", "image/svg+xml",
  ".md", ".markdown", ".txt", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".xml",
  ".html", ".css", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".rs", ".go", ".java", ".kt",
  ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".rb", ".php", ".sh", ".zsh", ".sql", ".log", ".ini",
  ".env", ".pdf", ".docx", ".xlsx", ".pptx", ".zip",
].join(",");

/** Why the selected model takes no images: declared text-only, or capability unknown. */
export type ModelImageBlock = "model" | "unknown";

export interface ComposerImagePolicy {
  accepts: boolean;
  blockedBy?: ModelImageBlock;
  mimeTypes: string[];
  maxBytes?: number;
}

export type ImageRefusal = ModelImageBlock | "type" | "size";
export type AttachmentPickerKind = "files" | "images";
export interface AttachmentPickerFilter {
  filter: "all-files" | "non-image" | "images";
  accept?: string;
}

interface FileLike {
  name: string;
  type: string;
  size?: number;
}

/**
 * Only an explicit `supported` allows images. `unsupported` blocks them, and
 * unknown or absent metadata (or no resolved model) blocks them too, matching
 * the gateway, which rejects images at admission when capability is unknown.
 */
export function composerImagePolicy(model?: AppModelSummary | null): ComposerImagePolicy {
  if (model?.image_input_support !== "supported") {
    const blockedBy = model?.image_input_support === "unsupported" ? "model" : "unknown";
    return { accepts: false, blockedBy, mimeTypes: [] };
  }
  const catalogTypes = model.image_accepted_mime_types?.length
    ? model.image_accepted_mime_types.map((type) => type.toLowerCase())
    : null;
  const mimeTypes = catalogTypes
    ? GATEWAY_IMAGE_MIME_TYPES.filter((type) => catalogTypes.includes(DERIVATIVE_MIME[type] ?? type))
    : GATEWAY_IMAGE_MIME_TYPES;
  const maxBytes = (model.image_max_inline_bytes ?? 0) > 0
    ? model.image_max_inline_bytes
    : undefined;
  return { accepts: true, mimeTypes, ...(maxBytes ? { maxBytes } : {}) };
}

function imageMime(file: FileLike): string | null {
  const type = file.type.toLowerCase();
  if (type) return GATEWAY_IMAGE_MIME_TYPES.includes(type) ? type : null;
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  return IMAGE_EXTENSION_MIME[extension] ?? null;
}

export function isImageFile(file: FileLike): boolean {
  return imageMime(file) !== null;
}

export function imageRefusal(file: FileLike, policy: ComposerImagePolicy): ImageRefusal | null {
  const mime = imageMime(file);
  if (!mime) return null;
  if (!policy.accepts) return policy.blockedBy ?? "model";
  if (!policy.mimeTypes.includes(mime)) return "type";
  if (policy.maxBytes !== undefined && (file.size ?? 0) > policy.maxBytes) return "size";
  return null;
}

export function attachmentPickerFilter(kind: AttachmentPickerKind, policy: ComposerImagePolicy): AttachmentPickerFilter {
  if (!policy.accepts) return { filter: "non-image", accept: NON_IMAGE_ACCEPT };
  return kind === "images" ? { filter: "images", accept: policy.mimeTypes.join(",") } : { filter: "all-files" };
}

export const NO_BLOCKED_ATTACHMENTS: ReadonlyMap<string, ImageRefusal> = new Map();

interface AttachmentLike {
  id: string;
  kind: string;
  file: { mime_type: string; safe_name: string; size_bytes: number };
}

/** Attached images the current model refuses (kept, but send is blocked). */
export function blockedImageAttachmentIds(
  attachments: AttachmentLike[],
  policy: ComposerImagePolicy,
): ReadonlyMap<string, ImageRefusal> {
  const blocked = new Map<string, ImageRefusal>();
  for (const attachment of attachments) {
    if (attachment.kind !== "image") continue;
    const refusal = imageRefusal(
      { name: attachment.file.safe_name, type: attachment.file.mime_type, size: attachment.file.size_bytes },
      policy,
    );
    if (refusal) blocked.set(attachment.id, refusal);
  }
  // A shared empty map keeps the store snapshot stable in the common case.
  return blocked.size > 0 ? blocked : NO_BLOCKED_ATTACHMENTS;
}

/** Few-word reason for tooltips and the refusal toast (owner copy rule: no explanation). */
export function imageRefusalLabel(refusal: ImageRefusal): string {
  if (refusal === "model") return appCopy.composer.imagesUnsupported;
  if (refusal === "unknown") return appCopy.composer.imageSupportUnknown;
  return refusal === "type" ? appCopy.composer.imageTypeUnsupported : appCopy.composer.imageTooLarge;
}
