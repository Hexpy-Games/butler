// Pair the web profile's Accept-CH opt-ins with its CDP identity, including
// worker requests, which have no webContentsId. Electron's CDP override alone
// supplies low-entropy hints but does not retain these negotiated high hints.
const profiles = new WeakSet();
const HIGH_HINTS = {
  "sec-ch-ua-full-version-list": data => brands(data.fullVersionList),
  "sec-ch-ua-full-version": data => JSON.stringify(data.fullVersion),
  "sec-ch-ua-platform-version": data => JSON.stringify(data.platformVersion),
  "sec-ch-ua-arch": data => JSON.stringify(data.architecture),
  "sec-ch-ua-bitness": data => JSON.stringify(data.bitness),
  "sec-ch-ua-model": data => JSON.stringify(data.model),
  "sec-ch-ua-wow64": data => data.wow64 ? "?1" : "?0",
  "sec-ch-ua-form-factors": data => data.formFactors.map(JSON.stringify).join(", "),
};
function brands(list) { return list.map(item => `${JSON.stringify(item.brand)};v=${JSON.stringify(item.version)}`).join(", "); }
function trusted(url) {
  const target = new URL(url);
  return target.protocol === "https:" || target.protocol === "http:" &&
    (target.hostname === "localhost" || target.hostname.endsWith(".localhost") || target.hostname.startsWith("127.") || target.hostname === "[::1]");
}
export function installIdentityHeaders(profile, identity) {
  if (profiles.has(profile)) return;
  profiles.add(profile);
  const accepted = new Map();
  profile.webRequest.onHeadersReceived((details, callback) => {
    const entry = Object.entries(details.responseHeaders ?? {}).find(([name]) => name.toLowerCase() === "accept-ch");
    if (entry && trusted(details.url)) {
      const hints = entry[1].join(",").toLowerCase().split(",").map(value => value.trim()).filter(value => Object.hasOwn(HIGH_HINTS, value));
      const origin = new URL(details.url).origin;
      if (accepted.size >= 4096 && !accepted.has(origin)) accepted.delete(accepted.keys().next().value);
      accepted.set(origin, hints);
    }
    callback({ responseHeaders: details.responseHeaders });
  });
  profile.webRequest.onBeforeSendHeaders((details, callback) => {
    void identity.then(({ userAgent, userAgentMetadata: data }) => {
      const headers = { ...details.requestHeaders };
      for (const name of Object.keys(headers)) if (name.toLowerCase() === "user-agent") headers[name] = userAgent;
      if (trusted(details.url)) {
        headers["sec-ch-ua"] = brands(data.brands);
        headers["sec-ch-ua-mobile"] = "?0";
        headers["sec-ch-ua-platform"] = JSON.stringify(data.platform);
        for (const name of accepted.get(new URL(details.url).origin) ?? []) {
          if (HIGH_HINTS[name]) headers[name] = HIGH_HINTS[name](data);
        }
      }
      callback({ requestHeaders: headers });
    }).catch(() => callback({ cancel: true }));
  });
}
