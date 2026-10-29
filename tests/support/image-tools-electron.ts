import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { browserAgentApp, waitBrowser } from "./browser-agent-app";
import { imageFixture } from "./image-provider";

type BridgeReply<T> = { ok: boolean; data: T; error?: { code: string } };
/** Real preload and main IPC: binary masks, signed metadata and byte-exact native download. */
export async function verifyImageToolsElectron(evidence: string) {
  const packageFile = resolve("packages/butler-app/client/electron/package.json");
  process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE ??= createRequire(packageFile)("electron") as string;
  const app = await browserAgentApp(evidence, () => null);
  const bridge = async <T>(method: string, input?: unknown): Promise<T> => {
    const reply = await app.page.expression<BridgeReply<T>>(`window.butlerApp[${JSON.stringify(method)}](${input === undefined ? "" : JSON.stringify(input)})`);
    assert(reply.ok, `${method}: ${reply.error?.code}`); return reply.data;
  };
  try {
    const catalog = await bridge<{ models: Array<{ model_ref: string; provider_id: string; default_quality: string }> }>("imageModelSettings");
    const model = catalog.models.find(model => model.provider_id === "openai")!; assert(model);
    const key = await app.gateway.api<{ credential: { id: string } }>("/credentials", { method: "POST", body: JSON.stringify({ provider_id: model.provider_id, api_key: "image-bridge-stub" }) });
    const selection = { model_ref: model.model_ref, credential_id: key.credential.id, default_quality: model.default_quality };
    const selected = await bridge<{ selected: typeof selection }>("imageModelSettings", { method: "PUT", body: selection });
    assert.deepEqual(selected.selected.model_ref, selection.model_ref);
    const session = (await app.gateway.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "Image bridge" }) })).session.id;
    const bytes = imageFixture(60, 140, 220, 192, 128);
    const image = await app.gateway.api<{ id: string }>("/internal/e2e/images/generated", { method: "POST", body: JSON.stringify({ session, data: bytes.toString("base64") }) });
    const meta = await bridge<{ id: string; image_url: string }>("imageAssetInfo", { path: `/message-assets/${image.id}/meta` });
    assert.equal(meta.id, image.id); assert(meta.image_url.includes("signature="));
    const versions = await bridge<Array<{ id: string }>>("imageAssetInfo", { path: `/message-assets/${image.id}/versions` });
    assert.deepEqual(versions.map(item => item.id), [image.id]);
    const maskBytes = [...imageFixture(0, 0, 0, 192, 128, 0)];
    const uploaded = await app.page.expression<BridgeReply<{ id: string }>>(`window.butlerApp.uploadImageMask({session:${JSON.stringify(session)},image:${JSON.stringify(image.id)},bytes:Uint8Array.from(${JSON.stringify(maskBytes)})})`);
    assert(uploaded.ok, `binary mask: ${uploaded.error?.code}`);
    const sent = await bridge<{ accepted: { turn_id: string } }>("sendMessage", { chatId: session, text: "Edit this image", clientMessageId: crypto.randomUUID(),
      imageEdit: { image: image.id, mask: uploaded.data.id }, accessMode: "auto" });
    assert(sent.accepted.turn_id);
    await waitBrowser(async () => {
      const view = await app.gateway.api<{ latest_turn: { state: string } }>(`/session-view?session_id=${session}`);
      return view.latest_turn.state === "delivered";
    }, "image editor message delivered over preload");
    assert(JSON.stringify(app.visionRequests ?? app.gateway.stubModelCalls).includes(`[Image editor: image ${image.id} · mask ${uploaded.data.id}]`));
    const path = join(evidence, "downloaded-original.png");
    const electron = `process.getBuiltinModule('module').createRequire(${JSON.stringify(packageFile)})('electron')`;
    await app.main(`${electron}.dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(path)}})`);
    const saved = await app.page.expression<{ saved: boolean }>(`window.butlerApp.saveImageAsset({id:${JSON.stringify(image.id)},suggestedName:'image.png'})`);
    assert(saved.saved); assert.deepEqual(readFileSync(path), bytes);
    console.log(JSON.stringify({ electronImageBridge: true, metadata: true, versions: 1, maskUploaded: true, imageEditDelivered: true, downloadBytes: bytes.length }));
  } finally { await app.stop(); }
}
