/**
 * Message-file URLs (`/message-files/<id>`) and their short-lived signed form.
 *
 * The gateway adds `signed_url` beside every message-file `url` it returns:
 * `/message-files/<id>?expires=<unix seconds>&signature=<base64url>`. Token-less
 * loads (`<img>`, the artifact viewer's fetch, links opened in a browser) use
 * it; the plain `url` stays the fallback (a browser session cookie still
 * authorizes it). Signed URLs expire after ten minutes and die with a token
 * rotation, so a failed load may refresh the owning list once: the fresh
 * signatures are remembered here by path and win over older ones.
 */

export interface MessageFileLink {
  url?: string;
  signed_url?: string;
}

const MESSAGE_FILE_URL_PATTERN = /^\/message-files\/file-[0-9a-f-]{36}$/iu;
const SIGNED_URL_PATTERN =
  /^(\/message-files\/file-[0-9A-Fa-f-]{36})\?expires=([0-9]{1,12})&signature=([A-Za-z0-9_-]{43})$/u;
const MAX_REMEMBERED = 500;

interface RememberedSignedUrl {
  signedUrl: string;
  expires: number;
}

const remembered = new Map<string, RememberedSignedUrl>();
const retriedPaths = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

/** The validated plain file path, or undefined for anything else. */
export function messageFilePath(url: string | undefined): string | undefined {
  return url && MESSAGE_FILE_URL_PATTERN.test(url) ? url : undefined;
}

/** The link's signed URL when it signs exactly the link's own file path. */
export function signedMessageFileUrl(link: MessageFileLink): string | undefined {
  const path = messageFilePath(link.url);
  const match = link.signed_url ? SIGNED_URL_PATTERN.exec(link.signed_url) : null;
  return path && match?.[1] === path ? link.signed_url : undefined;
}

/** Unix seconds a well-formed signed URL stays valid until. */
export function signedUrlExpiry(signedUrl: string): number | undefined {
  const match = SIGNED_URL_PATTERN.exec(signedUrl);
  return match ? Number(match[2]) : undefined;
}

/**
 * The relative source to load: the latest-expiring signed URL known for the
 * file (its own or a remembered refresh), else the plain path. Undefined when
 * the link does not name a message file.
 */
export function messageFileSource(link: MessageFileLink): string | undefined {
  const path = messageFilePath(link.url);
  if (!path) return undefined;
  const own = signedMessageFileUrl(link);
  const ownExpiry = own ? signedUrlExpiry(own) ?? 0 : -1;
  const fresher = remembered.get(path);
  if (fresher && fresher.expires > ownExpiry) return fresher.signedUrl;
  return own ?? path;
}

/** Resolves a gateway-relative URL against the desktop gateway when there is one. */
export function absoluteGatewayUrl(relativeUrl: string): string {
  const serverUrl =
    typeof window !== "undefined" ? window.butlerApp?.serverUrl : undefined;
  return serverUrl ? new URL(relativeUrl, serverUrl).toString() : relativeUrl;
}

/** Records every valid `{url, signed_url}` pair found in a JSON value. */
export function rememberSignedFileUrls(value: unknown): void {
  if (collectSignedUrls(value, 0)) {
    version += 1;
    for (const listener of listeners) listener();
  }
}

export function subscribeSignedFileUrls(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function signedFileUrlsVersion(): number {
  return version;
}

/** True once per file until it loads again: the one refresh a failure gets. */
export function claimMessageFileRetry(path: string): boolean {
  if (retriedPaths.has(path)) return false;
  retriedPaths.add(path);
  return true;
}

/** A successful load re-arms the file's retry for a later expiry. */
export function settleMessageFileLoad(path: string): void {
  retriedPaths.delete(path);
}

export function resetMessageFileUrlsForTest(): void {
  remembered.clear();
  retriedPaths.clear();
  version = 0;
}

function collectSignedUrls(value: unknown, depth: number): boolean {
  if (!value || typeof value !== "object" || depth > 32) return false;
  if (Array.isArray(value)) {
    let changed = false;
    for (const item of value) changed = collectSignedUrls(item, depth + 1) || changed;
    return changed;
  }
  const record = value as Record<string, unknown>;
  let changed = rememberLink(record);
  for (const child of Object.values(record)) {
    if (child && typeof child === "object") {
      changed = collectSignedUrls(child, depth + 1) || changed;
    }
  }
  return changed;
}

function rememberLink(record: Record<string, unknown>): boolean {
  if (typeof record.url !== "string" || typeof record.signed_url !== "string") {
    return false;
  }
  const signedUrl = signedMessageFileUrl({
    url: record.url,
    signed_url: record.signed_url,
  });
  const expires = signedUrl ? signedUrlExpiry(signedUrl) : undefined;
  if (!signedUrl || expires === undefined) return false;
  const current = remembered.get(record.url);
  if (current && current.expires >= expires) return false;
  remembered.delete(record.url);
  remembered.set(record.url, { signedUrl, expires });
  if (remembered.size > MAX_REMEMBERED) {
    const oldest = remembered.keys().next().value;
    if (oldest !== undefined) remembered.delete(oldest);
  }
  return true;
}
