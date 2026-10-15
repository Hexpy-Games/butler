// Client Hints for the web profile, as Chrome sends them. Electron has no
// Accept-CH store, so navigations carry no hints and documents get only the
// low-entropy set. Chrome sends no UA hints from workers; Electron attributes
// worker requests to their frame, but leaves them without Sec-CH-UA, so only
// navigations and requests that already carry Sec-CH-UA are completed here.
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
function origin(url) { try { return new URL(url).origin; } catch { return ""; } }
/** High-entropy hints a request gets: its document origin's opt-in. A
 * cross-origin frame navigation gets none (the hints' default policy is self). */
function highHints(details, accepted) {
  const target = origin(details.url);
  if (details.resourceType !== "subFrame") return accepted.get(target) ?? [];
  const top = origin(details.frame?.top?.url ?? "");
  return top === target ? accepted.get(top) ?? [] : [];
}
export function installIdentityHeaders(profile, identity) {
  if (profiles.has(profile)) return;
  profiles.add(profile);
  const accepted = new Map();
  profile.webRequest.onHeadersReceived((details, callback) => {
    const entry = Object.entries(details.responseHeaders ?? {}).find(([name]) => name.toLowerCase() === "accept-ch");
    if (entry && trusted(details.url)) {
      const hints = entry[1].join(",").toLowerCase().split(",").map(value => value.trim()).filter(value => Object.hasOwn(HIGH_HINTS, value));
      const key = origin(details.url);
      if (accepted.size >= 4096 && !accepted.has(key)) accepted.delete(accepted.keys().next().value);
      accepted.set(key, hints);
    }
    callback({ responseHeaders: details.responseHeaders });
  });
  profile.webRequest.onBeforeSendHeaders((details, callback) => {
    void identity.then(({ userAgent, userAgentMetadata: data }) => {
      const headers = { ...details.requestHeaders };
      const names = Object.keys(headers);
      for (const name of names) if (name.toLowerCase() === "user-agent") headers[name] = userAgent;
      const navigation = details.resourceType === "mainFrame" || details.resourceType === "subFrame";
      const hinted = names.some(name => name.toLowerCase() === "sec-ch-ua");
      if (trusted(details.url) && (navigation || hinted)) {
        for (const name of names) if (name.toLowerCase().startsWith("sec-ch-ua")) delete headers[name];
        headers["sec-ch-ua"] = brands(data.brands);
        headers["sec-ch-ua-mobile"] = "?0";
        headers["sec-ch-ua-platform"] = JSON.stringify(data.platform);
        for (const name of highHints(details, accepted)) headers[name] = HIGH_HINTS[name](data);
      }
      callback({ requestHeaders: headers });
    }).catch(() => callback({ cancel: true }));
  });
}
