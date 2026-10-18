import type { LogRecord } from "./logsApi";

// Non-JSON log routes: desktop goes through the preload; browsers use the
// gateway's same-origin session.

/** A redacted body by reference; desktop reads it through the preload, browsers fetch it. */
export async function readLogBody(reference: string): Promise<string> {
  const bridge = window.butlerApp;
  if (typeof bridge?.readLogBody === "function") {
    return String(await (bridge.readLogBody as (input: { reference: string }) => Promise<string>)({ reference }));
  }
  const response = await fetch(`/logs/bodies/${encodeURIComponent(reference)}`);
  if (!response.ok) throw new Error(`log body ${response.status}`);
  return await response.text();
}

export interface LogExportInput {
  since?: string;
  includeBodies: boolean;
}

/**
 * Saves a zip of the logs. Desktop asks main for a save dialog (main adds the
 * app's crash records); browsers download the agent's zip.
 */
export async function exportLogs(input: LogExportInput): Promise<boolean> {
  const bridge = window.butlerApp;
  if (typeof bridge?.exportLogs === "function") {
    const result = await (bridge.exportLogs as (value: LogExportInput) => Promise<{ saved: boolean }>)(input);
    return result.saved;
  }
  const response = await fetch("/logs/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ since: input.since, include_bodies: input.includeBodies }),
  });
  if (!response.ok) throw new Error(`log export ${response.status}`);
  const href = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = href;
  link.download = "butler-logs.zip";
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
  return true;
}

export interface LogStreamHandlers {
  onOpen: () => void;
  onRecord: (record: LogRecord) => void;
  /** The stream failed or ended; the caller decides whether to reconnect. */
  onError: () => void;
}

/** GET /logs/live; returns the unsubscribe function. */
export function subscribeLogs(handlers: LogStreamHandlers): () => void {
  const bridge = window.butlerApp;
  if (typeof bridge?.subscribeLogs === "function") {
    const close = (bridge.subscribeLogs as (value: LogStreamHandlers) => (() => void) | void)(handlers);
    return typeof close === "function" ? close : () => undefined;
  }
  const source = new EventSource("/logs/live");
  source.onopen = () => handlers.onOpen();
  source.addEventListener("log", (event) => {
    try {
      handlers.onRecord(JSON.parse((event as MessageEvent<string>).data) as LogRecord);
    } catch { /* A malformed line is skipped; the next one still arrives. */ }
  });
  // EventSource would retry on its own; one owner (the caller) decides instead.
  source.onerror = () => {
    source.close();
    handlers.onError();
  };
  return () => source.close();
}
