/** Offline UA/Client-Hints echo, including worker fetches and cross-site frames. */
export function identityFixture(crossSite = true) {
  const requests: Array<{ path: string; headers: Record<string, string> }> = [];
  const hints = "Sec-CH-UA, Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version, Sec-CH-UA-Mobile, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-WoW64";
  const report = `async function identity(){return {ua:navigator.userAgent,language:navigator.language,languages:navigator.languages,
    data:await navigator.userAgentData.getHighEntropyValues(['fullVersionList','platformVersion','architecture','bitness','model','wow64'])}}`;
  const server = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch(request): Response {
    const url = new URL(request.url), path = url.pathname;
    const headers = Object.fromEntries(request.headers);
    requests.push({ path, headers });
    const responseHeaders = { "accept-ch": hints, "permissions-policy": "ch-ua-full-version-list=*, ch-ua-platform-version=*, ch-ua-arch=*, ch-ua-bitness=*, ch-ua-wow64=*", "cache-control": "no-store" };
    if (path.endsWith("/echo")) return Response.json(headers, { headers: responseHeaders });
    if (path.endsWith("/worker.js")) return new Response(`${report};(async()=>postMessage({js:await identity(),headers:await(await fetch('./echo?worker')).json()}))()`, { headers: { "content-type": "text/javascript", ...responseHeaders } });
    const frame = path.endsWith("/frame");
    const origin = `http://${crossSite ? "localhost" : "127.0.0.1"}:${server.port}`;
    return new Response(`<!doctype html><meta charset=utf-8><title>Browser identity fixture</title><h1>Browser identity</h1><pre id=result>Pending</pre>
      <script>${report};globalThis.reports={};const parentHeaders=${JSON.stringify(headers)};
      const record=(name,value)=>{reports[name]=value;document.querySelector('#result').textContent=JSON.stringify(reports);if(reports.worker&&reports.iframe)dispatchEvent(new Event('identity-ready'));};
      (async()=>{record('page',{js:await identity(),headers:await(await fetch('./echo')).json(),navigation:parentHeaders});
        const worker=new Worker('./worker.js');worker.onmessage=e=>{record('worker',e.data);worker.terminate()};
        ${frame ? "parent.postMessage({frame:reports.page},'*')" : ""}
      })();addEventListener('message',e=>{if(e.data.frame)record('iframe',e.data.frame)});</script>
      ${frame || url.searchParams.has("no-frame") ? "" : `<iframe src="${origin}/__o/identity/frame"></iframe>`}`, { headers: { "content-type": "text/html", ...responseHeaders } });
  } });
  return { server, requests, url: `http://127.0.0.1:${server.port}/__o/identity/` };
}
