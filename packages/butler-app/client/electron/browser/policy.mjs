// Build metadata must advance with the pinned Electron major (official release schedule).
export const BROWSER_BUILD = Object.freeze({ major: 44, eol: "2027-03-02T00:00:00Z" });
export function browsingEnabled(version = process.versions.electron, now = Date.now()) {
  return Number(version?.split(".")[0]) === BROWSER_BUILD.major && now < Date.parse(BROWSER_BUILD.eol);
}
export function webUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function addressUrl(input) {
  if (typeof input !== "string" || input.length > 8192) throw new Error("invalid_address");
  const value = input.trim();
  if (!value) return null;
  const direct = webUrl(value);
  if (direct) return direct;
  if (/^[a-z][a-z\d+.-]*:/iu.test(value) && !/^[\w.-]+:\d+(?:\/|$)/u.test(value)) throw new Error("blocked_protocol");
  if (!/\s/u.test(value) && NAVIGABLE.test(value)) {
    const plain = webUrl(`http://${value}`);
    return plain && !localHost(new URL(plain).hostname) ? webUrl(`https://${value}`) : plain;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}
// A bracketed IPv6 literal, a dotted host, a single label before a port or path, or localhost.
const NAVIGABLE = /^(\[[\da-f:.]+\]|[\w.-]+\.[a-z\d-]+|[\w-]+(?=:\d|\/)|localhost)(:\d+)?(\/|$)/iu;
const LOCAL_SUFFIXES = [".localhost", ".local", ".home.arpa", ".internal"];
/** Hosts that cannot hold a public certificate (Chromium's non-unique/private destinations); typed bare, they open over http. */
function localHost(hostname) {
  if (hostname.startsWith("[")) {
    const lead = Number.parseInt(hostname.slice(1).split(":")[0] || "0", 16);
    return hostname === "[::1]" || (lead & 0xfe00) === 0xfc00 || (lead & 0xffc0) === 0xfe80;
  }
  if (/^[\d.]+$/u.test(hostname)) {
    const [a, b] = hostname.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b < 128);
  }
  return !hostname.includes(".") || LOCAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}
export function createLossBreaker(onTrip, now = Date.now) {
  let losses = [];
  let tripped = false;
  return {
    get tripped() { return tripped; },
    loss(hasTabs) {
      if (!hasTabs || tripped) return;
      const time = now();
      losses = losses.filter((at) => time - at < 600_000);
      losses.push(time);
      if (losses.length >= 5) { tripped = true; onTrip(); }
    },
  };
}
