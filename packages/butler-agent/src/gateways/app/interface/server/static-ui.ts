import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { apiError } from "../protocol/app-protocol.ts";
import { json } from "./responses.ts";

export const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const STATIC_SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' http://127.0.0.1:* http://localhost:*",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
} as const;

export function isStaticUiRequest(request: Request): boolean {
  if (request.method !== "GET") return false;
  const pathname = new URL(request.url).pathname;
  if (pathname === "/") return true;
  const extension = extname(pathname);
  return Boolean(extension && MIME_TYPES[extension]);
}

export async function serveStatic(
  root: string,
  pathname: string,
): Promise<Response> {
  const normalizedRoot = resolve(root);
  const relPath =
    pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const filePath = resolve(normalizedRoot, relPath);
  if (!isPathInsideRoot(normalizedRoot, filePath)) {
    return json(apiError("not_found", "Route not found."), 404);
  }
  if (!existsSync(filePath)) {
    const fallback = join(normalizedRoot, "index.html");
    if (!existsSync(fallback)) {
      return json(apiError("not_found", "Route not found."), 404);
    }
    return new Response(await readFile(fallback), {
      headers: staticHeaders(MIME_TYPES[".html"]),
    });
  }
  const type = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
  return new Response(await readFile(filePath), {
    headers: staticHeaders(type),
  });
}

function isPathInsideRoot(root: string, filePath: string): boolean {
  const normalizedRoot = root.toLocaleLowerCase("en-US");
  const normalizedFilePath = filePath.toLocaleLowerCase("en-US");
  return (
    normalizedFilePath === normalizedRoot ||
    normalizedFilePath.startsWith(`${normalizedRoot}${sep}`)
  );
}

function staticHeaders(contentType: string): HeadersInit {
  return {
    "content-type": contentType,
    ...STATIC_SECURITY_HEADERS,
  };
}
