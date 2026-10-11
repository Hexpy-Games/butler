// Preserve Chromium's native OS spelling and high-entropy platform facts.
// Chrome intentionally reports the frozen macOS/Windows UA tokens even on
// newer systems; platformVersion/architecture come from the running engine.
export function chromeIdentity(userAgent, fullVersion, native, acceptLanguage) {
  const major = Number(fullVersion.split(".")[0]);
  const chars = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
  const grease = `Not${chars[major % chars.length]}A${chars[(major + 1) % chars.length]}Brand`;
  const greaseVersion = ["8", "99", "24"][major % 3];
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const brands = (full) => {
    const list = [{ brand: grease, version: full ? `${greaseVersion}.0.0.0` : greaseVersion },
      { brand: "Chromium", version: full ? fullVersion : String(major) },
      { brand: "Google Chrome", version: full ? fullVersion : String(major) }];
    const shuffled = []; orders[major % 6].forEach((position, index) => { shuffled[position] = list[index]; });
    return shuffled;
  };
  return { userAgent: chromeUserAgent(userAgent, fullVersion), acceptLanguage,
  userAgentMetadata: { brands: brands(false), fullVersionList: brands(true), fullVersion,
    platform: native.platform, platformVersion: native.platformVersion, architecture: native.architecture,
    bitness: native.bitness, model: native.model, mobile: false, wow64: native.wow64, formFactors: ["Desktop"] } };
}

export function chromeUserAgent(userAgent, fullVersion) {
  const parts = userAgent.match(/^(Mozilla\/.*?\(KHTML, like Gecko\)).*?(?:Headless)?Chrome\/\S+.*?(\sSafari\/\S+)/u);
  if (!parts) throw new Error("browser_identity_unavailable");
  return `${parts[1]} Chrome/${fullVersion}${parts[2]}`;
}
