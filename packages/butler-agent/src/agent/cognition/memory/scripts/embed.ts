import { createConnection } from "net";

export type EmbeddingRuntimeMetadata = {
  model: string;
  dimension: number;
  pooling: "cls";
  normalize: true;
  version: string;
  max_tokens: number;
  transformers_version: string;
  node_runtime_version: string;
  bun_runtime_version: string | null;
  tokenizer_asset_sha256: string;
  model_asset_sha256: string;
};

export type CheckedEmbeddingResult = {
  embeddings: number[][];
  token_counts: number[];
  embedded_texts?: string[];
  omitted_count?: number;
  metadata: EmbeddingRuntimeMetadata;
};

export class CheckedEmbeddingError extends Error {
  constructor(readonly code: string, readonly maxTokens?: number) { super(code); }
}

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

export async function embedCheckedViaSocket(input: {
  texts: string[];
  expected?: EmbeddingRuntimeMetadata;
  socketPath?: string;
  timeoutMs?: number;
  resplit?: boolean;
  maxEmbeddings?: number;
  requestClass?: "interactive" | "background";
  deadlineAt?: number;
  signal?: AbortSignal;
}): Promise<CheckedEmbeddingResult> {
  const remainingDeadlineMs = input.deadlineAt === undefined ? Number.POSITIVE_INFINITY : input.deadlineAt - Date.now();
  if (remainingDeadlineMs <= 0) throw new CheckedEmbeddingError("embed_request_deadline");
  const configuredTimeoutMs = input.timeoutMs ?? 300_000;
  const timeoutMs = Math.max(1, Math.min(
    configuredTimeoutMs,
    remainingDeadlineMs,
  ));
  const result = await socketRequest({
    texts: input.texts,
    checked: true,
    resplit: input.resplit,
    max_embeddings: input.maxEmbeddings,
    request_class: input.requestClass,
    deadline_at: input.deadlineAt,
  }, input.socketPath ?? DEFAULT_SOCKET, timeoutMs, input.signal,
  input.deadlineAt !== undefined && remainingDeadlineMs <= configuredTimeoutMs) as Partial<CheckedEmbeddingResult> & { error?: string; code?: string; max_tokens?: number };
  if (result.error || result.code) throw new CheckedEmbeddingError(result.code ?? "embed_request_failed", result.max_tokens);
  if (!Array.isArray(result.embeddings) || !Array.isArray(result.token_counts) || !validMetadata(result.metadata))
    throw new CheckedEmbeddingError("embed_invalid_response");
  const metadata = result.metadata;
  const expectedCount = input.resplit ? result.embedded_texts?.length : input.texts.length;
  if (!Number.isSafeInteger(expectedCount) || result.embeddings.length !== expectedCount || result.token_counts.length !== expectedCount ||
    (input.resplit && (!Array.isArray(result.embedded_texts) || result.embedded_texts.some((text) => typeof text !== "string" || !text) || !Number.isSafeInteger(result.omitted_count) || result.omitted_count! < 0)) ||
    result.token_counts.some((count) => !Number.isSafeInteger(count) || count <= 0 || count > metadata.max_tokens) ||
    result.embeddings.some((vector) => vector.length !== metadata.dimension || vector.some((coordinate) => !Number.isFinite(coordinate))))
    throw new CheckedEmbeddingError("embed_invalid_response");
  if (input.expected && !sameEmbedding(input.expected, result.metadata))
    throw new CheckedEmbeddingError("embed_version_mismatch");
  return result as CheckedEmbeddingResult;
}

function socketRequest(value: unknown, socketPath: string, timeoutMs: number, signal?: AbortSignal, timeoutIsDeadline = false): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => { socket.destroy(); finish(() => reject(new CheckedEmbeddingError("embed_request_cancelled"))); };
    const timeout = setTimeout(() => { socket.destroy(); finish(() => reject(timeoutIsDeadline
      ? new CheckedEmbeddingError("embed_request_deadline")
      : new EmbedServerUnavailableError(socketPath))); }, timeoutMs);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("connect", () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on("data", (chunk) => { data += chunk.toString(); });
    socket.on("end", () => finish(() => { try { resolve(JSON.parse(data.trim())); } catch { reject(new CheckedEmbeddingError("embed_invalid_response")); } }));
    socket.on("error", (error) => finish(() => reject(error)));
  });
}

function validMetadata(value: unknown): value is EmbeddingRuntimeMetadata {
  const item = value as Partial<EmbeddingRuntimeMetadata> | null;
  return Boolean(item && typeof item.model === "string" && Number.isSafeInteger(item.dimension) && item.dimension! > 0 && item.pooling === "cls" && item.normalize === true &&
    validSha(item.version) && Number.isSafeInteger(item.max_tokens) && item.max_tokens! > 0 &&
    typeof item.transformers_version === "string" && item.transformers_version && typeof item.node_runtime_version === "string" && item.node_runtime_version &&
    (item.bun_runtime_version === null || typeof item.bun_runtime_version === "string") && validSha(item.tokenizer_asset_sha256) && validSha(item.model_asset_sha256));
}

function sameEmbedding(expected: EmbeddingRuntimeMetadata, observed: EmbeddingRuntimeMetadata): boolean {
  return expected.model === observed.model && expected.dimension === observed.dimension && expected.pooling === observed.pooling && expected.normalize === observed.normalize && expected.version === observed.version && expected.max_tokens === observed.max_tokens &&
    expected.transformers_version === observed.transformers_version && expected.node_runtime_version === observed.node_runtime_version && expected.bun_runtime_version === observed.bun_runtime_version &&
    expected.tokenizer_asset_sha256 === observed.tokenizer_asset_sha256 && expected.model_asset_sha256 === observed.model_asset_sha256;
}

function validSha(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value); }

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
