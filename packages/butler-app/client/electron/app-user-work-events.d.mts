export function watchAppUserWork(input: {
  connect: (signal: AbortSignal) => Promise<Response>;
  onChange?: () => void;
  onConnected?: () => void;
  onEvent?: (event: { type: string; payload?: { settings?: Record<string, unknown> } }) => void;
}): () => void;
