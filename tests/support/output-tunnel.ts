import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { NativeAppServerHandle } from "./native-app-server.ts";

/** Local TLS reverse proxy: real streams and Host routing, with a fixture cert. */
export function outputTunnel(server: NativeAppServerHandle) {
  const scratch = mkdtempSync(join(process.env.TMPDIR!, "output-tunnel-"));
  const cert = join(scratch, "cert.pem");
  const key = join(scratch, "key.pem");
  try {
    execFileSync(process.env.BUTLER_SMOKE_OPENSSL ?? "openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-subj", "/CN=butler.example.info", "-days", "1"], { stdio: "ignore" });
    const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: Bun.file(cert), key: Bun.file(key) },
      async fetch(request) {
        const url = new URL(request.url);
        const api = url.hostname === "butler.example.info";
        if (!api && url.hostname !== "outputs.example.info") return new Response(null, { status: 403 });
        const backend = new URL(server.url);
        if (!api) backend.port = String(server.port + 1);
        backend.pathname = url.pathname; backend.search = url.search;
        const headers = new Headers(request.headers);
        headers.set("host", url.host);
        if (api) for (const [name, value] of Object.entries(server.authHeaders)) headers.set(name, value);
        const response = await fetch(backend, { method: request.method, headers,
          body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer() });
        const returned = new Headers(response.headers);
        for (const name of ["content-encoding", "content-length", "transfer-encoding"]) returned.delete(name);
        return new Response(response.body, { status: response.status, headers: returned });
      },
    });
    return { apiHost: `butler.example.info:${proxy.port}`, contentHost: `outputs.example.info:${proxy.port}`,
      stop() { proxy.stop(true); rmSync(scratch, { recursive: true, force: true }); } };
  } catch (error) { rmSync(scratch, { recursive: true, force: true }); throw error; }
}
