/** A pending update wakes on committed events, never on an idle polling scan. */
export function watchAppUserWork({ connect, onChange, onEvent, onConnected = () => {} }) {
  const controller = new AbortController();
  let debounce = null;
  let reconnect = null;
  let reconnectDelay = 1000;
  function changed() {
    if (!onChange) return;
    clearTimeout(debounce);
    debounce = setTimeout(onChange, 100);
  }
  async function run() {
    try {
      const response = await connect(controller.signal);
      if (!response.ok || !response.body) throw new Error("work_stream_unavailable");
      reconnectDelay = 1000;
      onConnected();
      changed();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const lines = frame.split("\n");
            const heartbeat = lines.some(line => line.startsWith("event:") && line.slice(6).trim() === "heartbeat");
            if (lines.some(line => line.startsWith("data:")) && !heartbeat) {
              if (onEvent) {
                const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
                try { onEvent(JSON.parse(data)); } catch { /* Ignore malformed event frames. */ }
              }
              changed();
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch { /* Reconnect with current credentials after a service/token change. */ }
    if (!controller.signal.aborted) {
      reconnect = setTimeout(() => { void run(); }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    }
  }
  void run();
  return () => {
    controller.abort();
    clearTimeout(debounce);
    clearTimeout(reconnect);
  };
}
