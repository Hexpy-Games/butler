import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { OperationPayloadSource } from "../../core/index.ts";
import { ref, type ResultRef } from "../../operation-result/index.ts";

export class OperationPayloadFiles {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  import(source: OperationPayloadSource): {
    payloadRef: ResultRef;
    byteLength: number;
  } {
    if (typeof source === "string") {
      const payload = Buffer.from(source, "utf8");
      const payloadRef = ref("operation-payload", payload);
      this.persistBuffer(payloadRef.sha256, payload);
      return { payloadRef, byteLength: payload.byteLength };
    }

    const actual = statSync(source.path);
    if (actual.size !== source.byteLength) {
      throw new Error("Spooled operation result length changed before persistence");
    }
    const payloadRef = { id: `operation-payload:${source.sha256}`, sha256: source.sha256 };
    this.persistFile(payloadRef.sha256, source.path);
    return { payloadRef, byteLength: actual.size };
  }

  readAll(sha256: string): Buffer {
    const payload = readFileSync(this.path(sha256));
    this.assertDigest(sha256, payload);
    return payload;
  }

  readPrefix(sha256: string, length: number): Buffer {
    return this.readRange(sha256, 0, length);
  }

  readRange(sha256: string, start: number, length: number): Buffer {
    const path = this.path(sha256);
    const size = statSync(path).size;
    const safeStart = Math.min(start, size);
    const safeLength = Math.min(length, size - safeStart);
    const output = Buffer.alloc(safeLength);
    const file = openSync(path, "r");
    try {
      readSync(file, output, 0, safeLength, safeStart);
    } finally {
      closeSync(file);
    }
    return output;
  }

  private persistBuffer(sha256: string, payload: Buffer): void {
    const target = this.path(sha256);
    if (existsSync(target)) return;
    const temporary = this.temporaryPath(target);
    try {
      writeFileSync(temporary, payload, { flag: "wx" });
      this.syncFile(temporary);
      renameSync(temporary, target);
      this.syncDirectory(target);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  private persistFile(sha256: string, source: string): void {
    const target = this.path(sha256);
    if (this.digestFile(source) !== sha256) {
      throw new Error("Spooled operation result digest changed before persistence");
    }
    if (existsSync(target)) {
      if (source !== target && existsSync(source)) unlinkSync(source);
      return;
    }
    try {
      renameSync(source, target);
      this.syncFile(target);
      this.syncDirectory(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      const temporary = this.temporaryPath(target);
      try {
        copyFileSync(source, temporary);
        this.syncFile(temporary);
        renameSync(temporary, target);
        this.syncDirectory(target);
        unlinkSync(source);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    }
  }

  private assertDigest(sha256: string, payload: Buffer): void {
    if (ref("operation-payload", payload).sha256 !== sha256) {
      throw new Error("Operation result payload digest mismatch");
    }
  }

  private digestFile(path: string): string {
    const digest = createHash("sha256");
    const file = openSync(path, "r");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    try {
      for (;;) {
        const bytes = readSync(file, chunk, 0, chunk.byteLength, null);
        if (bytes === 0) break;
        digest.update(chunk.subarray(0, bytes));
      }
    } finally {
      closeSync(file);
    }
    return digest.digest("hex");
  }

  private path(sha256: string): string {
    return join(this.root, sha256);
  }

  private temporaryPath(target: string): string {
    return `${target}.${process.pid}.${randomUUID()}.tmp`;
  }

  private syncFile(path: string): void {
    const file = openSync(path, "r");
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
  }

  private syncDirectory(path: string): void {
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
}
