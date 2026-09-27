import { expect, test } from "bun:test";
import { setAppCopyLanguage } from "@/app/copy.ts";
import type { AppModelSummary } from "@/app/types.ts";
import {
  attachmentPickerFilter,
  blockedImageAttachmentIds,
  composerImagePolicy,
  imageRefusal,
  imageRefusalLabel,
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

test("only supported allows images; unsupported and unknown/missing block them", () => {
  expect(composerImagePolicy(model({ image_input_support: "supported" })).accepts).toBe(true);
  expect(composerImagePolicy(model({ image_input_support: "unsupported" }))).toEqual({
    accepts: false, blockedBy: "model", mimeTypes: [],
  });
  // Unknown capability matches the gateway, which rejects images at admission.
  for (const unknown of [model({ image_input_support: "unknown" }), model(), null, undefined]) {
    expect(composerImagePolicy(unknown)).toEqual({ accepts: false, blockedBy: "unknown", mimeTypes: [] });
  }
});

test("unknown capability refuses images with its own short reason", () => {
  setAppCopyLanguage("en-US");
  const unknown = composerImagePolicy(model({ image_input_support: "unknown" }));
  expect(imageRefusal(png, unknown)).toBe("unknown");
  expect(imageRefusal({ name: "a.pdf", type: "application/pdf", size: 10 }, unknown)).toBeNull();
  expect(imageRefusalLabel("unknown")).toBe("Image support unknown for this model");
  expect(imageRefusalLabel("model")).toBe("Model doesn't accept images");
  setAppCopyLanguage("ko-KR");
  expect(imageRefusalLabel("unknown")).toBe("이미지 지원 여부를 확인할 수 없는 모델");
  setAppCopyLanguage("en-US");
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

  const unlimited = composerImagePolicy(model({ image_input_support: "supported" }));
  expect(imageRefusal({ name: "a.webp", type: "image/webp", size: 10 ** 9 }, unlimited)).toBeNull();
});

test("picker accept excludes image MIME types unless the model supports images", () => {
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
  expect(attachmentPickerFilter("images", composerImagePolicy(model({ image_input_support: "supported" })))).toEqual({
    filter: "images", accept: "image/png,image/jpeg,image/webp,image/gif",
  });
  for (const blocked of [textOnly, composerImagePolicy(model())]) {
    expect(attachmentPickerFilter("files", blocked).filter).toBe("non-image");
    expect(attachmentPickerFilter("images", blocked).filter).toBe("non-image");
  }
});

test("already attached images are marked blocked after switching to a model that refuses them", () => {
  const attachments = [
    { id: "img", kind: "image" as const, file: { mime_type: "image/png", safe_name: "a.png", size_bytes: 10 } },
    { id: "doc", kind: "generic" as const, file: { mime_type: "application/pdf", safe_name: "a.pdf", size_bytes: 10 } },
  ];
  const textOnly = composerImagePolicy(model({ image_input_support: "unsupported" }));
  expect(blockedImageAttachmentIds(attachments, textOnly)).toEqual(new Map([["img", "model"]]));
  const unknown = composerImagePolicy(model({ image_input_support: "unknown" }));
  expect(blockedImageAttachmentIds(attachments, unknown)).toEqual(new Map([["img", "unknown"]]));
  const capable = composerImagePolicy(model({ image_input_support: "supported" }));
  expect(blockedImageAttachmentIds(attachments, capable).size).toBe(0);
});
