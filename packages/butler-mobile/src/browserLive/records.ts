export class LiveRecordParser {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private head = 0;
  private record: { type: number; length: number } | undefined;

  push(chunk: Uint8Array): Array<{ type: number; payload: Uint8Array }> {
    if (chunk.length) {
      this.chunks.push(chunk);
      this.bytes += chunk.length;
    }
    const records: Array<{ type: number; payload: Uint8Array }> = [];
    for (;;) {
      if (!this.record) {
        if (this.bytes < 5) break;
        const header = this.take(5);
        const type = header[0]!;
        const length = new DataView(header.buffer, header.byteOffset, 5).getUint32(1);
        if (type < 1 || type > 4) throw new Error("Unknown browser live record");
        if (length > 2 * 1024 * 1024) throw new Error("Browser live record exceeds 2 MiB");
        this.record = { type, length };
      }
      const { type, length } = this.record;
      if (this.bytes < length) break;
      records.push({ type, payload: this.take(length) });
      this.record = undefined;
    }
    if (this.head) {
      this.chunks.splice(0, this.head);
      this.head = 0;
    }
    return records;
  }

  private take(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    for (let offset = 0; offset < length;) {
      const chunk = this.chunks[this.head]!;
      const count = Math.min(length - offset, chunk.length);
      bytes.set(chunk.subarray(0, count), offset);
      offset += count;
      if (count === chunk.length) this.head++;
      else this.chunks[this.head] = chunk.subarray(count);
    }
    this.bytes -= length;
    return bytes;
  }
}
