/** A pending update wakes on committed events, never on an idle polling scan. */
export function watchAppUserWork({ connect, onChange }) {
  const controller = new AbortController();
  let debounce = null;
  let reconnect = null;
  function changed() {
    clearTimeout(debounce);
    debounce = setTimeout(onChange, 100);
  }
  async function run() {
    try {
      const response = await connect(controller.signal);
      if (!response.ok || !response.body) throw new Error("work_stream_unavailable");
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
            if (frame.includes("data:") && !frame.includes("event: heartbeat")) changed();
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch { /* Reconnect with current credentials after a service/token change. */ }
    if (!controller.signal.aborted) reconnect = setTimeout(() => { void run(); }, 1000);
  }
  void run();
  return () => {
    controller.abort();
    clearTimeout(debounce);
    clearTimeout(reconnect);
  };
}
