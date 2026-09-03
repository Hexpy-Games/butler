import { extractPageBytes } from "./page-extraction.ts";

try {
  const [url, contentType, status] = process.argv.slice(2);
  const statusCode = Number(status);
  const result = await extractPageBytes({
    url,
    contentType: contentType || null,
    status: statusCode,
    ok: statusCode >= 200 && statusCode < 300,
    bytes: new Uint8Array(await Bun.stdin.arrayBuffer()),
  });
  process.send!({ result });
} catch (error) {
  process.send!({ error: error instanceof Error ? error.message : String(error) });
} finally {
  process.disconnect!();
}
