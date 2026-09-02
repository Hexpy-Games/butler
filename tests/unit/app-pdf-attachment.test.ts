import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import { AppMessageFileStore } from "../../packages/butler-agent/src/gateways/app/domain/message-files/message-file-store.ts";
import { renderAttachmentContext } from "../../packages/butler-agent/src/agent/context/attachment-context.ts";

function textPdf(text: string): Uint8Array<ArrayBuffer> {
  const stream = `BT /F1 12 Tf 40 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

test("PDF upload preserves the original and supplies extracted content after message admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-pdf-upload-"));
  const server = createTestAppServer({
    dbPath: join(root, "app.sqlite"), butlerData: root, port: 0,
    responder: () => ({ texts: ["received"] }),
  });
  try {
    const bytes = textPdf("Butler PDF attachment content.");
    const form = new FormData();
    form.set("session_id", "general");
    // A mobile file picker may send no useful MIME type.
    form.set("file", new Blob([bytes]), "report.pdf");
    const response = await fetch(`${server.url}message-files`, { method: "POST", body: form });
    expect(response.status).toBe(201);
    const { data: { file } } = await response.json();
    expect(file.kind).toBe("generic");
    expect(file.mime_type).toBe("application/pdf");
    const download = await fetch(`${server.url}${file.url.slice(1)}`);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
    expect(readFileSync(join(root, "app-server", "message-files", `${file.file_id}.txt`), "utf8"))
      .toContain("Butler PDF attachment content.");

    const sent = await fetch(`${server.url}messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "general", text: "Read this PDF", attachments: [{ file_id: file.file_id }] }),
    });
    expect(sent.ok).toBe(true);
    const { data: { accepted } } = await sent.json();
    const store = new AppMessageFileStore(server.store.db, root, () => {});
    const context = renderAttachmentContext(store.attachmentsForTransport(accepted.id), {
      butlerData: root, maxAttachmentTextChars: 20,
    });
    expect(context).toContain("report.pdf");
    expect(context).toContain("Full extracted text file");
    expect(context).not.toContain("%PDF-1.4");
    expect(renderAttachmentContext(store.attachmentsForTransport(accepted.id), { butlerData: root }))
      .toContain("Butler PDF attachment content.");
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unreadable PDFs still upload with an explicit extraction limitation", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-pdf-unreadable-"));
  const server = createTestAppServer({ dbPath: join(root, "app.sqlite"), butlerData: root, port: 0 });
  try {
    const form = new FormData();
    form.set("file", new Blob(["%PDF-1.4 damaged"], { type: "application/pdf" }), "damaged.pdf");
    const response = await fetch(`${server.url}message-files`, { method: "POST", body: form });
    expect(response.status).toBe(201);
    const { data: { file } } = await response.json();
    expect(readFileSync(join(root, "app-server", "message-files", `${file.file_id}.txt`), "utf8"))
      .toContain("its contents have not been read");
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
