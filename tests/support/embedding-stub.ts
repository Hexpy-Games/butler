import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Serves checked-embedding requests on a private socket and points EMBED_SOCKET
 * at it, so memory projection tests never depend on a running embed-server
 * (such as the user's /tmp/butler-embed.sock).
 */
export async function startEmbeddingStub(): Promise<{ socketPath: string; stop(): Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), "butler-embed-stub-"));
  const socketPath = join(root, "embed.sock");
  const previous = process.env.EMBED_SOCKET;
  const server: Server = createServer((socket) => {
    let payload = "";
    socket.on("data", (chunk) => {
      payload += chunk.toString();
      if (!payload.includes("\n")) return;
      const request = JSON.parse(payload.trim()) as { texts?: string[] };
      const texts = request.texts ?? [];
      socket.end(`${JSON.stringify({
        embeddings: texts.map(() => [1, 0]),
        token_counts: texts.map(() => 2),
        embedded_texts: texts,
        omitted_count: 0,
        metadata: {
          model: "test/bge-m3", dimension: 2, pooling: "cls", normalize: true,
          version: "a".repeat(64), max_tokens: 8192, transformers_version: "test",
          node_runtime_version: process.version, bun_runtime_version: Bun.version,
          tokenizer_asset_sha256: "b".repeat(64), model_asset_sha256: "c".repeat(64),
        },
      })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  process.env.EMBED_SOCKET = socketPath;
  return {
    socketPath,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous === undefined) delete process.env.EMBED_SOCKET;
      else process.env.EMBED_SOCKET = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
