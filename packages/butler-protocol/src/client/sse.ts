export interface SseFrame { event: string; data: string; id?: string }

/** Incremental parser: feed decoded text in any chunking; returns the frames completed by this chunk. */
export function createSseParser(): { push(text: string): SseFrame[] } {
  let tail = "", data = "", event = "";
  let lastId: string | undefined;
  let skipLf = false;
  return {
    push(text) {
      if (!text) return [];
      if (skipLf && text.startsWith("\n")) text = text.slice(1);
      skipLf = text.endsWith("\r");
      const lines = (tail + text).split(/\r\n|\n|\r/);
      tail = lines.pop()!;
      const frames: SseFrame[] = [];
      for (const line of lines) {
        if (!line) {
          if (data) frames.push({ event: event || "message", data: data.slice(0, -1), id: lastId });
          data = event = "";
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") data += value + "\n";
        else if (field === "event") event = value;
        else if (field === "id" && !value.includes("\0")) lastId = value;
      }
      return frames;
    },
  };
}
