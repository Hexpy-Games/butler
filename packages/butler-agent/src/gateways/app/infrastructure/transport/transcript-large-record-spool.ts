import {
  appendFileSync,
  mkdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Stats } from "node:fs";
import type { TranscriptEvent } from "../../../../test-support/harness/transcripts.ts";
import { IncrementalJsonParser } from "./incremental-json-parser.ts";
import type {
  TranscriptProjectionCheckpoint,
} from "./transcript-projection-checkpoint-store.ts";
import {
  isTranscriptEventValue,
  readTranscriptBoundaryAnchor,
  readTranscriptBytes,
  TRANSCRIPT_BYTE_WINDOW,
} from "./transcript-byte-window.ts";

type ParseResult =
  | { kind: "pending" }
  | { kind: "invalid"; code: "invalid_utf8" | "invalid_json" | "invalid_record" }
  | { kind: "event"; event: TranscriptEvent; checkpoint: TranscriptProjectionCheckpoint };

export class TranscriptLargeRecordSpool {
  private readonly parsers = new Map<string, {
    parser: IncrementalJsonParser;
    offset: number;
    spoolPath: string;
  }>();

  constructor(private readonly butlerData: string) {}

  start(
    chatId: string,
    checkpoint: TranscriptProjectionCheckpoint,
    bytes: Buffer,
    modifiedAtMs: number,
  ): TranscriptProjectionCheckpoint {
    const spoolPath = this.pathFor(chatId, checkpoint.path);
    mkdirSync(join(this.butlerData, "transcript-projection-spool"), {
      recursive: true,
    });
    writeFileSync(spoolPath, bytes);
    return {
      ...checkpoint,
      modifiedAtMs,
      trailing: Buffer.alloc(0),
      spoolPath,
      spoolBytes: bytes.byteLength,
    };
  }

  extend(
    checkpoint: TranscriptProjectionCheckpoint,
    stats: Stats,
  ): { checkpoint: TranscriptProjectionCheckpoint; pending: boolean } {
    const readStart = checkpoint.projectedBytes + checkpoint.spoolBytes;
    const chunk = readTranscriptBytes(
      checkpoint.path,
      readStart,
      Math.min(TRANSCRIPT_BYTE_WINDOW, stats.size - readStart),
    );
    const newline = chunk.indexOf(0x0a);
    const recordBytes = newline < 0 ? chunk : chunk.subarray(0, newline);
    truncateSync(checkpoint.spoolPath, checkpoint.spoolBytes);
    appendFileSync(checkpoint.spoolPath, recordBytes);
    const spoolEndOffset = newline < 0 ? 0 : readStart + newline + 1;
    return {
      checkpoint: {
        ...checkpoint,
        modifiedAtMs: stats.mtimeMs,
        trailing: newline < 0
          ? Buffer.alloc(0)
          : Buffer.from(chunk.subarray(newline + 1)),
        spoolBytes: checkpoint.spoolBytes + recordBytes.byteLength,
        spoolEndOffset,
      },
      pending: spoolEndOffset > 0 || readStart + chunk.byteLength < stats.size,
    };
  }

  parseNext(
    chatId: string,
    checkpoint: TranscriptProjectionCheckpoint,
    stats: Stats,
  ): ParseResult {
    let state = this.parsers.get(chatId);
    if (!state || state.spoolPath !== checkpoint.spoolPath) {
      state = {
        parser: new IncrementalJsonParser(),
        offset: 0,
        spoolPath: checkpoint.spoolPath,
      };
      this.parsers.set(chatId, state);
    }
    const chunk = readTranscriptBytes(
      checkpoint.spoolPath,
      state.offset,
      Math.min(TRANSCRIPT_BYTE_WINDOW, checkpoint.spoolBytes - state.offset),
    );
    const final = state.offset + chunk.byteLength === checkpoint.spoolBytes;
    try {
      state.parser.push(chunk, final);
    } catch (error) {
      this.parsers.delete(chatId);
      return {
        kind: "invalid",
        code: error instanceof TypeError ? "invalid_utf8" : "invalid_json",
      };
    }
    state.offset += chunk.byteLength;
    if (!final) return { kind: "pending" };
    const value = state.parser.value();
    if (!isTranscriptEventValue(value)) {
      this.parsers.delete(chatId);
      return { kind: "invalid", code: "invalid_record" };
    }
    return {
      kind: "event",
      event: value,
      checkpoint: {
        ...checkpoint,
        projectedBytes: checkpoint.spoolEndOffset,
        modifiedAtMs: stats.mtimeMs,
        boundaryAnchor: readTranscriptBoundaryAnchor(
          checkpoint.path,
          checkpoint.spoolEndOffset,
        ),
        spoolPath: "",
        spoolBytes: 0,
        spoolEndOffset: 0,
      },
    };
  }

  complete(chatId: string, spoolPath: string): void {
    this.parsers.delete(chatId);
    rmSync(spoolPath, { force: true });
  }

  discard(chatId: string, spoolPath: string): void {
    this.complete(chatId, spoolPath);
  }

  discardOrphan(chatId: string, transcriptPath: string): void {
    this.complete(chatId, this.pathFor(chatId, transcriptPath));
  }

  matchesSource(checkpoint: TranscriptProjectionCheckpoint): boolean {
    try {
      return readTranscriptBoundaryAnchor(
        checkpoint.spoolPath,
        checkpoint.spoolBytes,
      ).equals(readTranscriptBoundaryAnchor(
        checkpoint.path,
        checkpoint.projectedBytes + checkpoint.spoolBytes,
      ));
    } catch {
      return false;
    }
  }

  private pathFor(chatId: string, path: string): string {
    const digest = createHash("sha256").update(`${chatId}\0${path}`).digest("hex");
    return join(this.butlerData, "transcript-projection-spool", `${digest}.json`);
  }
}
