import { expect, test } from "bun:test";
import type { AppModelSummary } from "@/app/types.ts";
import {
  attachmentPickerFilter,
  blockedImageAttachmentIds,
  composerImagePolicy,
  imageRefusal,
  isImageFile,
} from "./composerImagePolicy";

function model(fields: Partial<AppModelSummary> = {}): AppModelSummary {
  return {
    provider_id: "openai", provider_label: "OpenAI", model_id: "m", model_ref: "openai/m",
    display_name: "M", status: "available", default_reasoning_effort: "medium",
    reasoning_efforts: ["medium"], token_estimator: "tiktoken", runtime_supported: true,
    ...fields,
  };
}

const png = { name: "a.png", type: "image/png", size: 10 };

test("image kinds follow the gateway: png/jpeg/webp/gif by MIME, or by extension without a MIME", () => {
  expect(isImageFile(png)).toBe(true);
  expect(isImageFile({ name: "a.gif", type: "image/gif" })).toBe(true);
  expect(isImageFile({ name: "a.JPG", type: "" })).toBe(true);
  expect(isImageFile({ name: "a.svg", type: "image/svg+xml" })).toBe(false);
  expect(isImageFile({ name: "a.heic", type: "image/heic" })).toBe(false);
  expect(isImageFile({ name: "a.pdf", type: "application/pdf" })).toBe(false);
});

test("unsupported blocks images; supported and unknown allow them", () => {
  expect(composerImagePolicy(model({ image_input_support: "unsupported" })).accepts).toBe(false);
  expect(composerImagePolicy(model({ image_input_support: "supported" })).accepts).toBe(true);
  // Unknown or absent metadata is allowed: the catalog declares text-only models
  // explicitly, most models carry no image metadata, and the gateway's visual
  // admission remains the authority at send time.
  expect(composerImagePolicy(model({ image_input_support: "unknown" })).accepts).toBe(true);
  expect(composerImagePolicy(model()).accepts).toBe(true);
  expect(composerImagePolicy(null).accepts).toBe(true);
});

test("refusal reasons: model, catalog MIME list (gif counts as png), inline byte limit", () => {
  const textOnly = composerImagePolicy(model({ image_input_support: "unsupported" }));
  expect(imageRefusal(png, textOnly)).toBe("model");
  expect(imageRefusal({ name: "a.pdf", type: "application/pdf", size: 10 }, textOnly)).toBeNull();

  const limited = composerImagePolicy(model({
    image_input_support: "supported",
    image_accepted_mime_types: ["image/png", "image/jpeg"],
    image_max_inline_bytes: 100,
  }));
  expect(imageRefusal(png, limited)).toBeNull();
  expect(imageRefusal({ name: "a.gif", type: "image/gif", size: 10 }, limited)).toBeNull();
  expect(imageRefusal({ name: "a.webp", type: "image/webp", size: 10 }, limited)).toBe("type");
  expect(imageRefusal({ ...png, size: 101 }, limited)).toBe("size");

  const unknown = composerImagePolicy(model());
  expect(imageRefusal({ name: "a.webp", type: "image/webp", size: 10 ** 9 }, unknown)).toBeNull();
});

test("picker accept excludes image MIME types only for text-only models", () => {
  const allowed = composerImagePolicy(model({ image_input_support: "supported" }));
  expect(attachmentPickerFilter("files", allowed)).toEqual({ filter: "all-files" });

  const textOnly = composerImagePolicy(model({ image_input_support: "unsupported" }));
  const files = attachmentPickerFilter("files", textOnly);
  expect(files.filter).toBe("non-image");
  const accept = files.accept?.split(",") ?? [];
  expect(accept.length).toBeGreaterThan(0);
  for (const blocked of ["image/*", "image/png", "image/jpeg", "image/webp", "image/gif", ".png", ".jpg", ".jpeg", ".webp", ".gif"]) {
    expect(accept).not.toContain(blocked);
  }
  expect(accept).toContain(".pdf");
  expect(accept).toContain("text/*");

  const limited = composerImagePolicy(model({
    image_input_support: "supported", image_accepted_mime_types: ["image/png", "image/jpeg"],
  }));
  expect(attachmentPickerFilter("images", limited)).toEqual({
    filter: "images", accept: "image/png,image/jpeg,image/gif",
  });
  expect(attachmentPickerFilter("images", composerImagePolicy(model()))).toEqual({
    filter: "images", accept: "image/png,image/jpeg,image/webp,image/gif",
  });
});

test("already attached images are marked blocked after switching to a model that refuses them", () => {
  const attachments = [
    { id: "img", kind: "image" as const, file: { mime_type: "image/png", safe_name: "a.png", size_bytes: 10 } },
    { id: "doc", kind: "generic" as const, file: { mime_type: "application/pdf", safe_name: "a.pdf", size_bytes: 10 } },
  ];
  const textOnly = composerImagePolicy(model({ image_input_support: "unsupported" }));
  expect(blockedImageAttachmentIds(attachments, textOnly)).toEqual(new Map([["img", "model"]]));
  const capable = composerImagePolicy(model({ image_input_support: "supported" }));
  expect(blockedImageAttachmentIds(attachments, capable).size).toBe(0);
});
