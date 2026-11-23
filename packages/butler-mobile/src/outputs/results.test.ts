// test-category: pure-logic
import { expect, test } from "bun:test";
import type { MessageFileRef, SessionArtifactSummary } from "../../../butler-protocol/src/index.ts";
import { artifactTarget, fileViewMode, messageResults, resultDescription, sessionResults } from "./results";

test("fileViewMode", () => {
  expect(fileViewMode("report.PDF")).toBe("pdf");
  expect(fileViewMode("notes.md")).toBe("markdown");
  expect(fileViewMode("main.rs")).toBe("text");
  expect(fileViewMode("page.html")).toBe("html");
  expect(fileViewMode("photo.webp")).toBe("image");
  expect(fileViewMode("a.zip")).toBe("unsupported");
  expect(fileViewMode("summary", "report")).toBe("pdf");
  expect(fileViewMode("data", "csv_file")).toBe("text");
});

test("artifactTarget", () => {
  expect(artifactTarget({ kind: "web", id: "o1", title: "Page", created_at: "" })).toEqual({ kind: "output", id: "o1", title: "Page" });
  expect(artifactTarget({ kind: "image", id: "i1", file_id: "f1", title: "x.png", created_at: "" }))
    .toEqual({ kind: "image", path: "/message-files/f1", name: "x.png", title: "x.png" });
  expect(artifactTarget({ kind: "file", id: "f2", title: "x.zip", created_at: "" })).toBeNull();
});

test("messageResults", () => {
  const a: SessionArtifactSummary = { id: "A", kind: "file", title: "a.txt", created_at: "", deliverable: true };
  const b: SessionArtifactSummary = { ...a, id: "B", deliverable: false };
  const file: MessageFileRef = { file_id: "f1", kind: "text", mime_type: "text/plain", safe_name: "a.txt", size_bytes: 1, sha256: "hash", url: "/message-files/f1", created_at: "" };
  expect(messageResults({ artifacts: [a, b], attachments: [{ ...file, source_label: "ws" }] })).toEqual([a]);
  expect(messageResults({ artifacts: [], attachments: [file, { ...file, file_id: "f2" }] }).map(item => item.id))
    .toEqual(["artifact-f1", "artifact-f2"]);
});

test("sessionResults and resultDescription", () => {
  const older: SessionArtifactSummary = { id: "old", kind: "file", title: "a.pdf", source_label: "a.pdf", sha256: "hash", created_at: "2026-01-01", deliverable: true };
  const newer = { ...older, id: "new", created_at: "2026-01-03" };
  const middle = { ...older, id: "middle", source_label: "b.pdf", created_at: "2026-01-02" };
  expect(sessionResults([older, middle, { ...older, id: "hidden", deliverable: false }], [
    { id: "message", role: "assistant", text: "", artifacts: [newer] },
  ])).toEqual([newer, middle]);
  expect(resultDescription("a.pdf", 1536)).toBe("PDF · 1.5 KB");
});
