import { GatewayError } from "../../../butler-protocol/src/client/envelope.ts";
import { uuid } from "../settings/format";

export type InputEvent =
  | { t: "down" | "move" | "up"; x: number; y: number }
  | { t: "wheel"; x: number; y: number; dx: number; dy: number }
  | { t: "text"; value: string }
  | { t: "key"; key: "Backspace" | "Enter" };

type InputBatch = { client: string; seq: number; events: InputEvent[] };

export class InputQueue {
  private readonly client = uuid();
  private seq = 0;
  private events: InputEvent[] = [];
  private scheduled = false;
  private sending = false;

  constructor(private readonly send: (batch: InputBatch) => Promise<void>) {}

  push(...events: InputEvent[]) {
    for (const event of events) {
      const last = this.events.at(-1);
      if (event.t === "text") {
        const previous = last?.t === "text" ? last.value : "";
        if (last?.t === "text") this.events.pop();
        const text = Array.from(previous + event.value);
        for (let i = 0; i < text.length; i += 256) {
          this.events.push({ t: "text", value: text.slice(i, i + 256).join("") });
        }
      } else if (last?.t === "move" && event.t === "move") {
        this.events[this.events.length - 1] = event;
      } else if (last?.t === "wheel" && event.t === "wheel"
        && Math.abs(last.dx + event.dx) <= 4 && Math.abs(last.dy + event.dy) <= 4) {
        this.events[this.events.length - 1] = { ...event, dx: last.dx + event.dx, dy: last.dy + event.dy };
      } else {
        this.events.push(event);
      }
    }
    this.schedule();
  }

  private schedule() {
    if (this.scheduled || this.sending || !this.events.length) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      void this.flush();
    });
  }

  private async flush() {
    this.sending = true;
    const batch: InputBatch = { client: this.client, seq: ++this.seq, events: [] };
    const encoder = new TextEncoder();
    let bytes = encoder.encode(JSON.stringify(batch)).length;
    for (const event of this.events) {
      bytes += encoder.encode(JSON.stringify(event)).length + Number(batch.events.length > 0);
      if (bytes > 16 * 1024 || batch.events.length === 64) break;
      batch.events.push(event);
    }
    this.events.splice(0, batch.events.length);
    try {
      await this.send(batch);
    } catch (error) {
      if (!(error instanceof GatewayError) || error.status === 504) {
        await this.send(batch).catch(() => {});
      }
    } finally {
      this.sending = false;
      this.schedule();
    }
  }
}

export function textDiff(prev: string, next: string): { backspaces: number; insert: string } {
  const before = Array.from(prev);
  const after = Array.from(next);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  return { backspaces: before.length - prefix, insert: after.slice(prefix).join("") };
}
