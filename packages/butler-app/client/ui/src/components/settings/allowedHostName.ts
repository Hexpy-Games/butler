/** Longest host name (RFC 1035), plus room for `:port`. */
const MAX_HOST_LENGTH = 253 + 6;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/**
 * `value` as the gateway stores it (trimmed, lower case) when it is a DNS
 * name, an IPv4 address or a bracketed IPv6 address, with an optional port;
 * null otherwise. Mirrors the gateway's allowed-host rule, which has the
 * final say.
 */
export function normalizeAllowedHost(value: string): string | null {
  const host = value.trim().toLowerCase();
  if (!host || host.length > MAX_HOST_LENGTH) return null;
  const parts = splitPort(host);
  if (!parts) return null;
  const [name, port] = parts;
  if (port !== undefined && !isPort(port)) return null;
  const literal = name.startsWith("[") ? name.slice(1, -1) : undefined;
  return (literal === undefined ? isDnsName(name) : isIpv6(literal)) ? host : null;
}

/** `name[:port]`; a bracketed IPv6 literal keeps its colons. */
function splitPort(host: string): [string, string | undefined] | null {
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close < 0) return null;
    const rest = host.slice(close + 1);
    if (!rest) return [host, undefined];
    return rest.startsWith(":") ? [host.slice(0, close + 1), rest.slice(1)] : null;
  }
  const [name, port, extra] = host.split(":");
  return extra === undefined ? [name, port] : null;
}

function isPort(port: string): boolean {
  return /^\d{1,5}$/u.test(port) && Number(port) > 0 && Number(port) <= 65_535;
}

function isDnsName(name: string): boolean {
  const bare = name.endsWith(".") ? name.slice(0, -1) : name;
  return bare.length > 0 && bare.split(".").every((label) => DNS_LABEL.test(label));
}

function isIpv6(literal: string): boolean {
  if (!literal.includes(":")) return false;
  try {
    return new URL(`http://[${literal}]/`).hostname.length > 0;
  } catch {
    return false;
  }
}
