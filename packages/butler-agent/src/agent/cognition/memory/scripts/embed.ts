import { createConnection } from "net";

const DEFAULT_SOCKET = process.env.EMBED_SOCKET ?? "/tmp/butler-embed.sock";
const EMBED_BATCH_SIZE = parseInt(process.env.EMBED_BATCH_SIZE ?? "32", 10);

export class EmbedServerUnavailableError extends Error {
  constructor(socketPath: string) {
    super(`embed-server timed out after 300s (socket: ${socketPath}). Server may be overloaded or stuck; check: butler logs --service embed-server`);
    this.name = "EmbedServerUnavailableError";
  }
}

export async function embedViaSocket(text: string, socketPath = DEFAULT_SOCKET, timeoutMs = 300000): Promise<number[] | null> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new EmbedServerUnavailableError(socketPath));
    }, timeoutMs);

    const socket = createConnection(socketPath);
    let data = "";

    socket.on("connect", () => {
      socket.write(JSON.stringify({ text }) + "\n");
    });

    socket.on("data", (chunk) => {
      data += chunk.toString();
    });

    socket.on("end", () => {
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(data.trim()) as { embedding?: number[]; error?: string };
        if (parsed.embedding) {
          resolve(parsed.embedding);
        } else {
          reject(new Error(`embed-server returned error: ${parsed.error ?? "no embedding in response"}`));
        }
      } catch {
        reject(new Error("embed-server returned invalid JSON"));
      }
    });

    socket.on("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

export async function embedBatchViaSocket(texts: string[], socketPath = DEFAULT_SOCKET, timeoutMs = 300000): Promise<number[][]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new EmbedServerUnavailableError(socketPath));
    }, timeoutMs);

    const socket = createConnection(socketPath);
    let data = "";

    socket.on("connect", () => {
      socket.write(JSON.stringify({ texts }) + "\n");
    });

    socket.on("data", (chunk) => {
      data += chunk.toString();
    });

    socket.on("end", () => {
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(data.trim()) as { embeddings?: number[][]; error?: string };
        if (parsed.embeddings) {
          resolve(parsed.embeddings);
        } else {
          reject(new Error(`embed-server returned error: ${parsed.error ?? "no embeddings in response"}`));
        }
      } catch {
        reject(new Error("embed-server returned invalid JSON"));
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export async function embed(text: string, socketPath = DEFAULT_SOCKET): Promise<number[] | null> {
  return embedViaSocket(text, socketPath);
}

export async function embedBatch(texts: string[], socketPath = DEFAULT_SOCKET): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];

  const results: (number[] | null)[] = new Array(texts.length).fill(null);
  const batchSize = EMBED_BATCH_SIZE > 0 ? EMBED_BATCH_SIZE : 32;

  for (let i = 0; i < texts.length; i += batchSize) {
    const chunk = texts.slice(i, i + batchSize);
    try {
      const embeddings = await embedBatchViaSocket(chunk, socketPath);
      for (let j = 0; j < chunk.length; j++) {
        results[i + j] = embeddings[j] ?? null;
      }
    } catch {
      for (let j = 0; j < chunk.length; j++) {
        results[i + j] = await embed(chunk[j], socketPath);
      }
    }
  }

  return results;
}
