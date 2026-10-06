// Build metadata must advance with the pinned Electron major (official release schedule).
export const BROWSER_BUILD = Object.freeze({ major: 44, eol: "2027-03-02T00:00:00Z" });
export function browsingEnabled(version = process.versions.electron, now = Date.now()) {
  return !process.env.BUTLER_BROWSER_DISABLED && Number(version?.split(".")[0]) === BROWSER_BUILD.major && now < Date.parse(BROWSER_BUILD.eol);
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
  if (!/\s/u.test(value) && /^(localhost|[\w.-]+\.[a-z\d-]+)(:\d+)?(\/|$)/iu.test(value)) {
    return webUrl(`${value.startsWith("localhost") ? "http" : "https"}://${value}`);
  }
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
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
