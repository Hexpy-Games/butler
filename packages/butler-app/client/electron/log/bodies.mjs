import { promisify } from "node:util";
import { zstdCompress } from "node:zlib";
const compress = promisify(zstdCompress);

/** Same independent zstd frames and body_ref format as the agent body reader. */
export async function writeBody(writer, body) {
  const bytes = await compress(Buffer.from(JSON.stringify(body)));
  let entry = await writer.segment("bodies");
  if (entry.bytes && entry.bytes + bytes.length > 16 * 1024 * 1024) {
    await writer.close("bodies");
    entry = await writer.segment("bodies");
  }
  const name = entry.path.split(/[\\/]/u).at(-1);
  const reference = `${name}:${entry.bytes}:${bytes.length}`;
  await entry.file.writeFile(bytes);
  entry.bytes += bytes.length;
  await writer.prune("bodies");
  return reference;
}
