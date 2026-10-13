// Real App: native gateway, built UI, guided answer_blocks tool and offline provider stream.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { createNativeAppServer } from "../support/native-app-server";
import { launchSmokeBrowser } from "../support/smoke-browser";
import type { MessageRecord } from "../../packages/butler-app/client/ui/src/app/types";

const evidence = process.env.BUTLER_ANSWER_EVIDENCE;
assert(evidence, "BUTLER_ANSWER_EVIDENCE required");
mkdirSync(evidence, { recursive: true });
let toolShown = false;
let replyRound = 0;
let chatId = "";
let release: (() => void) | undefined;
const text = "A complete streaming reply. ";
const imageId = "img_record0001";
const gateway = await createNativeAppServer({ uiRoot: resolve("packages/butler-app/client/ui/dist"), stubReply: () => "",
  stubToolCall: call => {
    if (!call.stream || toolShown) return null;
    toolShown = true;
    return { name: "answer_blocks", arguments: { v: 1, blocks: [{ type: "cards", id: "records", items: [
      { key: "one", title: "Record One", text: "First record.", img: imageId }, { key: "two", title: "Record Two", text: "Second record.", img: imageId },
    ] }] } };
  },
  async *stubTextStream() {
    if (replyRound++ === 0) { yield "Two records ready."; return; }
    // Hold the provider until the live card DOM is captured, then stream a long answer.
    await new Promise<void>(done => { release = done; });
    for (let index = 0; index < 200; index++) {
      yield index === 199 ? text.trimEnd() : text;
      await new Promise(done => setTimeout(done, 20));
    }
  },
});
const browser = await launchSmokeBrowser();
try {
  const created = await gateway.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "Streaming records" }) });
  chatId = created.session.id;
  // Seed a photo in the isolated fixture store; the real gateway validates and signs it.
  const photo = readFileSync(resolve("packages/butler-app/client/ui/src/libs/design-system/blocks/Wallpaper/modules/butler.photo-daisies/photo.jpg"));
  const hash = createHash("sha256").update(photo).digest("hex");
  const assetDir = join(gateway.butlerData, "app-server/assets", hash.slice(0, 2));
  mkdirSync(assetDir, { recursive: true }); writeFileSync(join(assetDir, `${hash}.jpg`), photo);
  const db = new Database(join(gateway.butlerData, "app-server/butler-client.sqlite"));
  try {
    db.query("INSERT INTO app_assets VALUES(?,?,'image/jpeg',2000,1266,?,'Record photo','',?)").run(imageId, hash, photo.length, new Date().toISOString());
    db.query("INSERT INTO app_asset_refs VALUES(?,'chat',?)").run(imageId, chatId);
  } finally { db.close(); }
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await gateway.signIn(page);
  await page.goto(gateway.url);
  await page.locator('[data-test-class="tree-row"][aria-label="Streaming records"]').last().click();
  await page.locator('[data-lexical-editor="true"]').waitFor();
  await gateway.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: chatId, text: "Show two structured records.", client_message_id: crypto.randomUUID() }) });
  await page.locator('[data-slot="item-card"]').first().waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-slot="item-card"] img')].length === 2 &&
    [...document.querySelectorAll('[data-slot="item-card"] img')].every(image => (image as HTMLImageElement).naturalWidth > 0));
  await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('[data-slot="item-card"]')];
    const images = [...document.querySelectorAll('[data-slot="item-card"] img')];
    const state = { cards: nodes, images, loads: 0 };
    images.forEach(image => image.addEventListener("load", () => state.loads++));
    Object.assign(window, { streamCards: state });
  });
  await page.screenshot({ path: join(evidence, "real-app-blocks-arrived.png") });
  await gateway.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: chatId, text: "Explain the records in detail.", client_message_id: crypto.randomUUID() }) });
  const streamDeadline = Date.now() + 30_000;
  while (!release && Date.now() < streamDeadline) await new Promise(done => setTimeout(done, 50));
  assert(release, "provider waits for the mounted cards");
  release();
  const deadline = Date.now() + 30_000;
  let final: MessageRecord | undefined;
  while (Date.now() < deadline) {
    const result = await gateway.api<{ messages: MessageRecord[] }>(`/messages?chat_id=${chatId}`);
    final = result.messages.find(message => message.role === "assistant" && message.status === "delivered" && message.text.includes("A complete streaming reply."));
    if (final) break;
    await new Promise(done => setTimeout(done, 100));
  }
  assert(final, "turn completes");
  assert.equal(final.text, text.repeat(200).trimEnd(), "complete final response");
  await page.waitForFunction(() => [...document.querySelectorAll('[data-test-class="turn-result-section"]')]
    .some(node => (node.textContent?.match(/A complete streaming reply\./gu)?.length ?? 0) === 200));
  const stable = await page.evaluate(() => {
    const original = (window as Window & { streamCards?: { cards: Element[]; images: Element[]; loads: number } }).streamCards!;
    const nodes = [...document.querySelectorAll('[data-slot="item-card"]')];
    const images = [...document.querySelectorAll('[data-slot="item-card"] img')];
    return { stableNodes: original.cards.length === nodes.length && original.cards.every((node, index) => node === nodes[index]), cards: nodes.length,
      stableImages: original.images.every((node, index) => node === images[index]), imageLoads: original.loads };
  });
  assert(stable.stableNodes);
  assert.equal(stable.cards, 2);
  assert(stable.stableImages);
  assert.equal(stable.imageLoads, 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(evidence, "real-app-stream-complete.png") });
  const result = { ...stable, deltas: 200, finalTextLength: final.text.length, nativeGateway: true, builtApp: true,
    scope: "existing cards during a subsequent streamed reply; same-message blocks arrive only at finalize today", liveModelCalls: 0 };
  writeFileSync(join(evidence, "real-app-stream.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  writeFileSync(join(evidence, "real-app-failure.log"), gateway.diagnostics());
  writeFileSync(join(evidence, "real-app-failure-messages.json"), JSON.stringify(await gateway.api(`/messages?chat_id=${chatId}`), null, 2));
  const page = browser.contexts()[0]?.pages()[0];
  if (page) await page.screenshot({ path: join(evidence, "real-app-failure.png") });
  throw error;
} finally { release?.(); await browser.close(); await gateway.stop(); }
