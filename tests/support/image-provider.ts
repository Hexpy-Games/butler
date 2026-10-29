import { deflateSync } from "node:zlib";

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(kind: string, body: Buffer) {
  const data = Buffer.concat([Buffer.from(kind), body]);
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(body.length); checksum.writeUInt32BE(crc32(data));
  return Buffer.concat([length, data, checksum]);
}
export function imageFixture(red: number, green: number, blue: number, width = 128, height = 128, alpha = 255): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * (width * 4 + 1) + 1 + x * 4;
    pixels[index] = red; pixels[index + 1] = green; pixels[index + 2] = blue; pixels[index + 3] = alpha;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
/** Mirrors PR 3's fake image provider: billed paths stay entirely on loopback. */
export function startImageProvider() {
  const requests: Array<{ path: string; bytes: number }> = [];
  let release: (() => void) | undefined;
  let held: Promise<void> | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!/^\/v1\/images\/(generations|edits)$/u.test(path)) return new Response(null, { status: 404 });
    const bytes = await request.arrayBuffer(); requests.push({ path, bytes: bytes.byteLength });
    await held;
    const png = path.endsWith("edits") ? imageFixture(230, 130, 70) : imageFixture(60, 140, 220, 192, 128);
    return Response.json({ data: [{ b64_json: png.toString("base64") }],
      usage: { input_tokens: 30, input_tokens_details: { text_tokens: 10, image_tokens: 20 }, output_tokens: 40 } });
  } });
  return { server, requests, base: `http://127.0.0.1:${server.port}/v1`,
    hold() { held = new Promise(done => { release = done; }); },
    release() { release?.(); held = undefined; } };
}
