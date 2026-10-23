// Generated attachment fixtures for the attachment smokes: photos, a large photo, a short video and files.
// Pictures and the video are drawn in the smoke's Chromium (canvas, MediaRecorder); nothing is downloaded.
import { strict as assert } from "node:assert";
import type { Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";

export interface FixtureFile { name: string; mimeType: string; buffer: Buffer }
/** A stored message file as the gateway returns it. */
export interface StoredFile { file_id: string; url: string; signed_url?: string; safe_name: string; kind: string; mime_type: string }

const PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>endobj
trailer<</Root 1 0 R>>
%%EOF
`;

/** A JPEG photo-like gradient with a few shapes, `width`×`height`, in hue `hue`. */
export async function drawPhoto(page: Page, name: string, width: number, height: number, hue: number): Promise<FixtureFile> {
  const data = await page.evaluate(async ({ width, height, hue }) => {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d")!;
    const sky = context.createLinearGradient(0, 0, width, height);
    sky.addColorStop(0, `hsl(${hue} 70% 72%)`); sky.addColorStop(1, `hsl(${(hue + 60) % 360} 60% 38%)`);
    context.fillStyle = sky; context.fillRect(0, 0, width, height);
    for (let index = 0; index < 6; index++) {
      context.fillStyle = `hsl(${(hue + index * 40) % 360} 65% ${40 + index * 6}% / 0.8)`;
      context.beginPath();
      context.arc(width * (0.15 + index * 0.14), height * (0.3 + (index % 3) * 0.2), Math.min(width, height) * 0.12, 0, Math.PI * 2);
      context.fill();
    }
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, { width, height, hue });
  return { name, mimeType: "image/jpeg", buffer: Buffer.from(data) };
}

/** A two-second WebM of a moving disc, recorded from a canvas. */
export async function recordVideo(page: Page, name: string): Promise<FixtureFile> {
  const data = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 240;
    document.body.append(canvas);
    const context = canvas.getContext("2d")!;
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: "video/webm" });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise((done) => { recorder.onstop = done; });
    recorder.start();
    const started = performance.now();
    await new Promise<void>((done) => {
      const draw = (now: number) => {
        const t = (now - started) / 2000;
        context.fillStyle = "#1d3b5a"; context.fillRect(0, 0, 320, 240);
        context.fillStyle = "#f4b860"; context.beginPath(); context.arc(40 + t * 240, 120, 36, 0, Math.PI * 2); context.fill();
        if (t < 1) requestAnimationFrame(draw); else done();
      };
      requestAnimationFrame(draw);
    });
    recorder.stop();
    await stopped;
    canvas.remove();
    return Array.from(new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer()));
  });
  assert.ok(data.length > 1000, "the recorded video has frames");
  return { name, mimeType: "video/webm", buffer: Buffer.from(data) };
}

/** The mixed set: two photos, a video, a PDF, a Word file and a file without an extension. */
export async function mixedFixtures(page: Page, language: string): Promise<FixtureFile[]> {
  const ko = language === "ko";
  return [
    await drawPhoto(page, ko ? "제주_해변.jpg" : "beach.jpg", 1600, 1200, 200),
    await drawPhoto(page, ko ? "노을.jpg" : "sunset.jpg", 1200, 1600, 20),
    await recordVideo(page, ko ? "드론_영상.webm" : "drone.webm"),
    { name: ko ? "2분기_보고서.pdf" : "q2-report.pdf", mimeType: "application/pdf", buffer: Buffer.from(PDF) },
    { name: ko ? "계약서_초안_v3.docx" : "contract-draft-v3.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("PK\u0003\u0004 docx fixture") },
    { name: "LICENSE", mimeType: "application/octet-stream", buffer: Buffer.from("fixture license") },
  ];
}

/** The stub model takes images, so image attachments pass admission. */
export async function allowStubImages(server: NativeAppServerHandle, serverUrl: string): Promise<void> {
  await server.api("/model-catalog/local-models/stub", { method: "PATCH", body: JSON.stringify({
    provider_id: "local", api_type: "openai_compatible", platform: "custom", server_url: serverUrl,
    model_id: "stub", display_name: "Stub", context_window_tokens: 128000, source: "manual", image_input: true,
  }) });
}

export async function uploadFixture(server: NativeAppServerHandle, sessionId: string, file: FixtureFile): Promise<StoredFile> {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(file.buffer)], { type: file.mimeType }), file.name);
  form.set("session_id", sessionId);
  const response = await fetch(new URL("message-files", server.url), { method: "POST", headers: server.authHeaders, body: form });
  const payload = await response.json() as { data?: { file: StoredFile } };
  assert.equal(response.status, 201, `upload ${file.name}: ${JSON.stringify(payload).slice(0, 300)}`);
  return payload.data!.file;
}

/** Sends one user message carrying `files` and waits for the stub turn to finish. */
export async function sendWithFiles(server: NativeAppServerHandle, sessionId: string, text: string, files: StoredFile[]): Promise<void> {
  await server.api("/messages", { method: "POST", body: JSON.stringify({
    chat_id: sessionId, text, client_message_id: crypto.randomUUID(), attachments: files,
  }) });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const view = await server.api<{ latest_turn?: { state?: string } }>(`/session-view?session_id=${encodeURIComponent(sessionId)}`);
    if (view.latest_turn?.state === "delivered") return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("The stub turn with attachments did not finish");
}
