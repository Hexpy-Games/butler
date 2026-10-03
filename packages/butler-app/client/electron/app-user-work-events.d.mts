export function watchAppUserWork(input: {
  connect: (signal: AbortSignal) => Promise<Response>;
  onChange: () => void;
}): () => void;
