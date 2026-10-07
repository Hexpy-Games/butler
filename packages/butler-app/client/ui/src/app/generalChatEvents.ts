const listeners = new Set<() => void>();
export function subscribeGeneralChatCleared(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function generalChatCleared(): void { for (const listener of listeners) listener(); }
