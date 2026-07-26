import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

const STREAM_BUFFER_BYTES = 64 * 1024;

export class ContentBlobStore {
  constructor(private readonly root: string) {
    mkdirSync(join(root, ".tmp"), { recursive: true });
  }

  captureFile(sourcePath: string): {
    contentSha256: string;
    byteLength: number;
  } {
    const temporary = join(this.root, ".tmp", randomUUID());
    const source = openSync(sourcePath, "r");
    const target = openSync(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(STREAM_BUFFER_BYTES);
    let byteLength = 0;
    let captured = false;
    try {
      while (true) {
        const read = readSync(source, buffer, 0, buffer.length, null);
        if (read === 0) break;
        const bytes = buffer.subarray(0, read);
        hash.update(bytes);
        writeAll(target, bytes);
        byteLength += read;
      }
      fsyncSync(target);
      captured = true;
    } finally {
      closeSync(source);
      closeSync(target);
      if (!captured) rmSync(temporary, { force: true });
    }
    const contentSha256 = hash.digest("hex");
    const acceptedPath = this.pathFor(contentSha256);
    mkdirSync(dirname(acceptedPath), { recursive: true });
    if (existsSync(acceptedPath)) {
      rmSync(temporary, { force: true });
    } else {
      try {
        renameSync(temporary, acceptedPath);
      } catch (error) {
        rmSync(temporary, { force: true });
        if (!existsSync(acceptedPath)) throw error;
      }
    }
    return { contentSha256, byteLength };
  }

  materialize(contentSha256: string, targetPath: string): void {
    const source = this.pathFor(contentSha256);
    if (!existsSync(source)) {
      throw new Error(`BTCC artifact blob is missing: ${contentSha256}`);
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(source, targetPath);
  }

  pathFor(contentSha256: string): string {
    return join(this.root, contentSha256.slice(0, 2), contentSha256);
  }
}

function writeAll(target: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(target, bytes, offset, bytes.length - offset);
  }
}
