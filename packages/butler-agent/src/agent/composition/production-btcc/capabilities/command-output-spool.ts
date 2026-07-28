import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  unlinkSync,
  type WriteStream,
} from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { SpooledOperationOutput } from "../../../btcc/core/index.ts";

export type CommandOutputSummary = {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
};

export class CommandOutputSpool {
  private readonly stdoutPath: string;
  private readonly stderrPath: string;
  private readonly payloadPath: string;
  private readonly stdout: WriteStream;
  private readonly stderr: WriteStream;

  constructor(butlerData: string) {
    const root = join(butlerData, "runtime", "btcc", "operation-spool");
    mkdirSync(root, { recursive: true });
    const id = `${process.pid}-${randomUUID()}`;
    this.stdoutPath = join(root, `${id}.stdout`);
    this.stderrPath = join(root, `${id}.stderr`);
    this.payloadPath = join(root, `${id}.payload`);
    this.stdout = createWriteStream(this.stdoutPath, { flags: "wx" });
    this.stderr = createWriteStream(this.stderrPath, { flags: "wx" });
  }

  capture(stdout: Readable, stderr: Readable): void {
    stdout.pipe(this.stdout);
    stderr.pipe(this.stderr);
  }

  async complete(summary: CommandOutputSummary): Promise<SpooledOperationOutput> {
    await Promise.all([finished(this.stdout), finished(this.stderr)]);
    const digest = createHash("sha256");
    let byteLength = 0;
    const payload = createWriteStream(this.payloadPath, { flags: "wx" });
    const write = async (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      digest.update(bytes);
      byteLength += bytes.byteLength;
      if (!payload.write(bytes)) await once(payload, "drain");
    };
    try {
      await write(`${JSON.stringify(summary)}\n--- stdout ---\n`);
      await copyInto(this.stdoutPath, write);
      await write("\n--- stderr ---\n");
      await copyInto(this.stderrPath, write);
      payload.end();
      await finished(payload);
      return {
        kind: "spooled_operation_output",
        summary,
        payloadSource: {
          kind: "spooled_text",
          path: this.payloadPath,
          sha256: digest.digest("hex"),
          byteLength,
          mediaType: "text/plain; charset=utf-8",
        },
      };
    } catch (error) {
      payload.destroy();
      this.discard();
      throw error;
    } finally {
      remove(this.stdoutPath);
      remove(this.stderrPath);
    }
  }

  discard(): void {
    this.stdout.destroy();
    this.stderr.destroy();
    remove(this.stdoutPath);
    remove(this.stderrPath);
    remove(this.payloadPath);
  }
}

async function copyInto(
  path: string,
  write: (chunk: Buffer) => Promise<void>,
): Promise<void> {
  for await (const chunk of createReadStream(path)) {
    await write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
}

function remove(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}
