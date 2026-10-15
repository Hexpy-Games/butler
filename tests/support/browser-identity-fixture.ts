// test-category: security
/** Offline UA/Client-Hints echo, including worker fetches and cross-site frames. */
import { strict as assert } from "node:assert";

type Identity = { ua: string; language: string; data: Record<string, any> };
type Report = { js: Identity; headers: Record<string, string> };

/** `cross-site`: a localhost frame under a 127.0.0.1 page. `sandboxed`: an
 * opaque-origin frame on the page's own origin, for guards that admit only it. */
export function identityFixture(frameMode: "cross-site" | "sandboxed" = "cross-site") {
  const requests: Array<{ path: string; headers: Record<string, string> }> = [];
  const hints = "Sec-CH-UA, Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version, Sec-CH-UA-Mobile, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-WoW64";
  const report = `async function identity(){return {ua:navigator.userAgent,language:navigator.language,languages:navigator.languages,
    data:await navigator.userAgentData.getHighEntropyValues(['fullVersionList','platformVersion','architecture','bitness','model','wow64'])}}`;
  const server = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch(request): Response {
    const url = new URL(request.url), path = url.pathname;
    const headers = Object.fromEntries(request.headers);
    requests.push({ path, headers });
    const responseHeaders = { "accept-ch": hints, "permissions-policy": "ch-ua-full-version-list=*, ch-ua-platform-version=*, ch-ua-arch=*, ch-ua-bitness=*, ch-ua-wow64=*", "cache-control": "no-store" };
    if (path.endsWith("/echo")) return Response.json(headers, { headers: { ...responseHeaders, "access-control-allow-origin": "*" } });
    if (path.endsWith("/worker.js")) return new Response(`${report};(async()=>postMessage({js:await identity(),headers:await(await fetch('./echo?worker')).json()}))()`, { headers: { "content-type": "text/javascript", ...responseHeaders } });
    const frame = path.endsWith("/frame");
    const frameTag = frameMode === "sandboxed" ? "<iframe sandbox=allow-scripts src=/__o/identity/frame></iframe>"
      : `<iframe src="http://localhost:${server.port}/__o/identity/frame"></iframe>`;
    // A sandboxed frame has an opaque origin and cannot start a worker.
    const worker = frame && frameMode === "sandboxed" ? "" : "const worker=new Worker('./worker.js');worker.onmessage=e=>{record('worker',e.data);worker.terminate()};";
    return new Response(`<!doctype html><meta charset=utf-8><title>Browser identity fixture</title><h1>Browser identity</h1><pre id=result>Pending</pre>
      <script>${report};globalThis.reports={};const parentHeaders=${JSON.stringify(headers)};
      const record=(name,value)=>{reports[name]=value;document.querySelector('#result').textContent=JSON.stringify(reports);if(reports.worker&&reports.iframe)dispatchEvent(new Event('identity-ready'));};
      (async()=>{record('page',{js:await identity(),headers:await(await fetch('./echo')).json(),navigation:parentHeaders});
        ${worker}
        ${frame ? "parent.postMessage({frame:reports.page},'*')" : ""}
      })();addEventListener('message',e=>{if(e.data.frame)record('iframe',e.data.frame)});</script>
      ${frame || url.searchParams.has("no-frame") ? "" : frameTag}`, { headers: { "content-type": "text/html", ...responseHeaders } });
  } });
  return { server, requests, url: `http://127.0.0.1:${server.port}/__o/identity/` };
}

const brandList = (list: Array<{ brand: string; version: string }>) => list.map(b => `${JSON.stringify(b.brand)};v=${JSON.stringify(b.version)}`).join(", ");
const uaHints = (headers: Record<string, string>) => Object.keys(headers).filter(name => name.startsWith("sec-ch-ua")).sort();

/** Butler's honest identity in every context, with consistent Client Hints: pages and
 * frames send them; workers send none (as Chrome itself does). */
export function assertBrowserIdentity(reports: Record<string, Report>, chrome: string, requests: Array<{ path: string; headers: Record<string, string> }>, product: "Butler" | "Google Chrome" = "Butler") {
  const page = reports.page.js;
  const major = chrome.split(".")[0];
  assert.doesNotMatch(page.ua, /Electron\/|HeadlessChrome/u);
  assert.ok(page.ua.includes(` Chrome/${chrome} `), page.ua);
  if (product === "Butler") {
    assert.match(page.ua, / Safari\/537\.36 Butler\/(\S+)$/u);
    for (const list of [page.data.brands, page.data.fullVersionList]) assert.ok(!list.some((b: any) => b.brand === "Google Chrome"));
  } else assert.doesNotMatch(page.ua, /Butler\//u); // The Rust reader runs stock Chrome for Testing.
  const appVersion = page.ua.split("Butler/")[1];
  for (const brand of [product, "Chromium"]) {
    assert.ok(page.data.brands.some((b: any) => b.brand === brand && b.version === (brand === "Butler" ? appVersion.split(".")[0] : major)), brand);
    assert.ok(page.data.fullVersionList.some((b: any) => b.brand === brand && b.version === (brand === "Butler" ? appVersion : chrome)), brand);
  }
  assert.equal(page.data.mobile, false);
  for (const context of ["page", "worker", "iframe"]) {
    const { js, headers } = reports[context];
    assert.equal(js.ua, page.ua, context); assert.deepEqual(js.data, page.data, context);
    assert.equal(headers["user-agent"], js.ua, context);
    assert.equal(headers["accept-language"]?.split(",")[0].split(";")[0], js.language, context);
    if (context === "worker") { assert.deepEqual(uaHints(headers), [], context); continue; }
    assert.equal(headers["sec-ch-ua"], brandList(js.data.brands), context);
    assert.equal(headers["sec-ch-ua-mobile"], "?0", context);
    assert.equal(headers["sec-ch-ua-platform"], JSON.stringify(js.data.platform), context);
    assert.equal(headers["sec-ch-ua-full-version-list"], brandList(js.data.fullVersionList), context);
    assert.equal(headers["sec-ch-ua-platform-version"], JSON.stringify(js.data.platformVersion), context);
    assert.equal(headers["sec-ch-ua-arch"], JSON.stringify(js.data.architecture), context);
    assert.equal(headers["sec-ch-ua-bitness"], JSON.stringify(js.data.bitness), context);
    assert.equal(headers["sec-ch-ua-wow64"], js.data.wow64 ? "?1" : "?0", context);
  }
  // Every request the web content made, documents and worker scripts included.
  assert.ok(requests.length > 0);
  for (const request of requests) {
    assert.equal(request.headers["user-agent"], page.ua, request.path);
    const fromWorker = request.path.endsWith("/worker.js") || request.headers.referer?.endsWith("/worker.js");
    if (fromWorker) assert.deepEqual(uaHints(request.headers), [], request.path);
    else assert.equal(request.headers["sec-ch-ua"], brandList(page.data.brands), request.path);
  }
}
