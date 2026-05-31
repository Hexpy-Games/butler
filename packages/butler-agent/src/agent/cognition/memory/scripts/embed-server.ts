import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { createServer as netCreateServer } from "net";
import { createServer as httpCreateServer } from "http";
import { existsSync, unlinkSync } from "fs";

const DEFAULT_SOCKET = process.env.EMBED_SOCKET ?? "/tmp/butler-embed.sock";

export function createServer(
  embedFn: (text: string) => Promise<number[]>,
  socketPath = DEFAULT_SOCKET,
  embedBatchFn?: (texts: string[]) => Promise<number[][]>,
) {
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }

  // Serialize all model inference via a promise chain to prevent concurrent forward passes
  let queue: Promise<void> = Promise.resolve();
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = queue.then(fn);
    queue = result.then(() => {}, () => {});
    return result;
  }

  const server = netCreateServer((socket) => {
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) return;

      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);

      let req: { text?: string; texts?: string[] };
      try {
        req = JSON.parse(line);
      } catch {
        socket.write(JSON.stringify({ error: "Invalid JSON" }) + "\n");
        socket.end();
        return;
      }

      // Batch request
      if (Array.isArray(req.texts)) {
        const texts = req.texts;
        if (texts.length === 0 || !texts.every((t) => typeof t === "string")) {
          socket.write(JSON.stringify({ error: "Invalid 'texts' field" }) + "\n");
          socket.end();
          return;
        }
        const batchFn = embedBatchFn ?? ((ts: string[]) => Promise.all(ts.map(embedFn)));
        enqueue(() => batchFn(texts))
          .then((embeddings) => {
            socket.write(JSON.stringify({ embeddings }) + "\n");
            socket.end();
          })
          .catch((err) => {
            socket.write(JSON.stringify({ error: String(err) }) + "\n");
            socket.end();
          });
        return;
      }

      // Single request
      if (typeof req.text !== "string" || !req.text) {
        socket.write(JSON.stringify({ error: "Missing 'text' or 'texts' field" }) + "\n");
        socket.end();
        return;
      }

      const text = req.text;
      enqueue(() => embedFn(text))
        .then((embedding) => {
          socket.write(JSON.stringify({ embedding }) + "\n");
          socket.end();
        })
        .catch((err) => {
          socket.write(JSON.stringify({ error: String(err) }) + "\n");
          socket.end();
        });
    });

    socket.on("error", () => {});
  });

  server.listen(socketPath);

  const cleanup = () => {
    try {
      if (existsSync(socketPath)) unlinkSync(socketPath);
    } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  return {
    stop() {
      server.close();
      cleanup();
    },
  };
}

if (import.meta.main) {
  let _pipe: FeatureExtractionPipeline | null = null;

  async function getPipe(): Promise<FeatureExtractionPipeline> {
    if (!_pipe) {
      const createPipeline = pipeline as unknown as (
        task: "feature-extraction",
        model: string,
        options: { dtype: "q8" },
      ) => Promise<FeatureExtractionPipeline>;
      _pipe = await createPipeline("feature-extraction", "Xenova/bge-m3", { dtype: "q8" });
    }
    return _pipe;
  }

  async function embedText(text: string): Promise<number[]> {
    const pipe = await getPipe();
    const out = await pipe(text, { pooling: "mean", normalize: true });
    return Array.from(out.data) as number[];
  }

  async function embedTexts(texts: string[]): Promise<number[][]> {
    const pipe = await getPipe();
    const out = await pipe(texts, { pooling: "mean", normalize: true });
    const dims = out.data.length / texts.length;
    const result: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      result.push(Array.from(out.data.slice(i * dims, (i + 1) * dims)) as number[]);
    }
    return result;
  }

  console.log("Loading bge-m3 model...");
  await getPipe();
  console.log(`embed-server ready on socket ${DEFAULT_SOCKET}`);

  createServer(embedText, DEFAULT_SOCKET, embedTexts);

  // Health check HTTP endpoint for monitoring
  const HEALTH_PORT = parseInt(process.env.EMBED_HEALTH_PORT ?? "9847", 10);
  const healthServer = httpCreateServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", socket: DEFAULT_SOCKET, uptime: process.uptime() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.on("error", (err: NodeJS.ErrnoException) => {
    console.warn(`embed-server health check failed to bind port ${HEALTH_PORT}: ${err.message} — continuing without health endpoint`);
  });
  healthServer.listen(HEALTH_PORT, "127.0.0.1", () => {
    console.log(`embed-server health check on http://127.0.0.1:${HEALTH_PORT}/health`);
  });
}
