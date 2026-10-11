/** Offline sign-in fixtures served by Host header: a shop with a login, MFA,
 * a cookie-echo account page, a checkout with postcode/pay/cross-site frames and
 * card fields, hop pages to an ungranted site, a same-site look-alike login and
 * a security-keypad bank page. No real accounts; nothing leaves 127.0.0.1. */
export const HOSTS = ["login.fixture-shop.test", "www.fixture-shop.test", "files.fixture-shop.test", "www.fixture-evil.test",
  "ads.fixture-ads.test", "bank.fixture-bank.test", "postcode.map.daum.net", "js.tosspayments.com"];

const page = (title: string, body: string) => new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;padding:24px}iframe{width:420px;height:120px;border:1px solid #ccc}</style>${body}`, { headers: { "content-type": "text/html; charset=utf-8" } });

export interface SignInFixture { url: (host: string, path: string) => string; posts: string[]; stop: () => void; }

export function startSignInFixtures(password: string): SignInFixture {
  const posts: string[] = [];
  let port = 0;
  const url = (host: string, path: string) => `http://${host}:${port}${path}`;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const target = new URL(request.url);
    const host = (request.headers.get("host") ?? "").split(":")[0];
    const path = target.pathname;
    const cookie = request.headers.get("cookie") ?? "";
    if (request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      posts.push(`${host}${path}`);
      if (host === "login.fixture-shop.test" && path === "/session") {
        // The canary never echoes back; only whether it matched.
        const ok = form.get("username") === "owner@fixture.test" && form.get("password") === password;
        if (!ok) return page("Wrong", "<h1>Wrong password</h1>");
        return new Response(null, { status: 302, headers: { location: url("login.fixture-shop.test", "/mfa"), "set-cookie": "pending=1; Domain=fixture-shop.test; Path=/" } });
      }
      if (host === "login.fixture-shop.test" && path === "/mfa") {
        return new Response(null, { status: 302, headers: { location: url("www.fixture-shop.test", "/account"), "set-cookie": "sid=owner; Domain=fixture-shop.test; Path=/" } });
      }
      return page("Posted", "<h1>Posted</h1>");
    }
    if (host === "login.fixture-shop.test" && path === "/login") {
      return page("Sign in", `<form method="post" action="/session"><label>Email <input name="username" type="email" autocomplete="username"></label>
        <label>Password <input name="password" type="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>`);
    }
    if (host === "login.fixture-shop.test" && path === "/mfa") {
      return page("Verify", `<form method="post" action="/mfa"><label>인증번호 <input name="code" autocomplete="one-time-code" inputmode="numeric"></label><button>Verify</button></form>`);
    }
    if (host === "files.fixture-shop.test" && path === "/login") {
      return page("Sign in", `<form method="post" action="/steal"><input name="username" type="email"><input name="password" type="password"><button>Sign in</button></form>`);
    }
    if (host === "www.fixture-shop.test" && path === "/account") {
      const signedIn = /(?:^|; )sid=owner/u.test(cookie);
      return page("Account", `<h1>${signedIn ? "Signed in as owner" : "Signed out"}</h1><a id="checkout" href="/checkout">Checkout</a>`);
    }
    if (host === "www.fixture-shop.test" && path === "/checkout") {
      return page("Checkout", `<h1>주문서</h1><label>받는 분 <input name="to"></label>
        <iframe id="postcode" src="${url("postcode.map.daum.net", "/search")}"></iframe>
        <iframe id="pay" src="${url("js.tosspayments.com", "/widget")}"></iframe>
        <iframe id="ad" src="${url("ads.fixture-ads.test", "/slot")}"></iframe>
        <form><label>Card number <input name="card" autocomplete="cc-number"></label><button type="submit">결제</button></form>`);
    }
    if (host === "www.fixture-shop.test" && path === "/hops") {
      const evil = url("www.fixture-evil.test", "/collect");
      return page("Hops", `<a id="redirect" href="/redirect">Redirect</a><a id="link" href="${evil}">Link</a>
        <form id="post" method="post" action="${evil}"><button>Post</button></form>
        <iframe id="frame" srcdoc="<a id='top' target='_top' href='${evil}'>Top</a>"></iframe>`);
    }
    if (host === "www.fixture-shop.test" && path === "/redirect") return new Response(null, { status: 302, headers: { location: url("www.fixture-evil.test", "/collect") } });
    if (host === "www.fixture-shop.test" && path === "/refresh") return page("Refresh", `<meta http-equiv="refresh" content="0;url=${url("www.fixture-evil.test", "/collect")}">`);
    if (host === "postcode.map.daum.net") return page("Postcode", `<input aria-label="도로명 주소" name="q"><button>주소 검색</button>`);
    if (host === "js.tosspayments.com") return page("Pay", `<button>결제하기</button>`);
    if (host === "ads.fixture-ads.test") return page("Ad", `<a href="#" onclick="this.textContent='설치됨';return false">지금 설치</a>
      <label>광고 계정 비밀번호 <input name="pw" type="password"></label>
      <label>쿠폰 <input name="coupon" onkeydown="if(event.key==='Enter')this.value+='!'"></label>`);
    if (host === "bank.fixture-bank.test") {
      const keys = Array.from({ length: 12 }, (_, index) => `<img class="keypad-key" alt="" width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-key="${index}">`).join("");
      return page("Bank", `<label>비밀번호 <input id="pin" type="password" readonly></label><div class="keypad">${keys}</div>`);
    }
    if (host === "www.fixture-evil.test") return page("Collected", "<h1>Collected</h1>");
    return new Response("not found", { status: 404 });
  } });
  port = server.port ?? 0;
  return { url, posts, stop: () => server.stop(true) };
}

/** Chromium maps the fixture hosts to the local server (connections only). */
export function hostResolverRules(): string {
  return `--host-resolver-rules=${HOSTS.map(host => `MAP ${host} 127.0.0.1`).join(", ")}`;
}

/** Test-only: the guard's DNS pre-check sees a public documentation address for
 * fixture hosts, so the loopback deny stays intact for every other host. */
export function publicResolverPatch(module: string): string {
  return `(() => { const { session } = ${module}('electron'); const proto = Object.getPrototypeOf(session.defaultSession);
    if (proto.__signinFixtures) return; proto.__signinFixtures = true; const original = proto.resolveHost;
    const hosts = new Set(${JSON.stringify(HOSTS)});
    proto.resolveHost = function (host, options) { return hosts.has(host) ? Promise.resolve({ endpoints: [{ address: "203.0.113.10", family: "ipv4" }] }) : original.call(this, host, options); };
  })()`;
}
