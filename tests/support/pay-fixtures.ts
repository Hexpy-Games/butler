import { autofillFixture } from "./autofill-fixtures";
/** Offline payment fixtures served by Host header: a checkout with cc-* fields,
 * a PG-style cross-origin iframe with split Korean card fields, a PG pop-up
 * window, a security-keypad PIN, a 3-D Secure challenge frame and a
 * look-alike origin. No real cards, merchants or payment endpoints; nothing
 * leaves 127.0.0.1. Posted values are compared here and only the verdict kept. */
export const HOSTS = ["www.fixture-shop.test", "files.fixture-shop.test", "js.tosspayments.com", "stdpay.inicis.com", "acs.fixture-bank.test"];

const page = (title: string, body: string) => new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;padding:24px}iframe{width:520px;height:300px;border:1px solid #ccc}input{display:block;margin:6px 0;font:16px system-ui;width:260px}</style>${body}`,
{ headers: { "content-type": "text/html; charset=utf-8" } });

export interface Card { number: string; month: string; year: string; cvc: string; name: string; pin2: string; owner: string }
export interface PayFixture { url: (host: string, path: string) => string; verdicts: string[]; stop: () => void }

const ccForm = (action: string, amount: string) => `<h1>주문 결제</h1><p>총 결제금액 ${amount}</p><form method="post" action="${action}">
  <label>Card number <input name="cardnumber" autocomplete="cc-number" inputmode="numeric"></label>
  <label>Expiry <input name="exp" autocomplete="cc-exp" placeholder="MM/YY"></label>
  <label>CVC <input name="cvc" autocomplete="cc-csc"></label>
  <label>Name on card <input name="ccname" autocomplete="cc-name"></label>
  <button type="submit">결제</button></form>`;

export function startPayFixtures(card: Card): PayFixture {
  const verdicts: string[] = [];
  let port = 0;
  const url = (host: string, path: string) => `http://${host}:${port}${path}`;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const host = (request.headers.get("host") ?? "").split(":")[0];
    const path = new URL(request.url).pathname;
    const profile = autofillFixture(request, path, verdicts);
    if (profile) return profile;
    if (request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      const ok = (name: string, expected: string) => (form.get(name) ?? "").replace(/\s/gu, "") === expected.replace(/\s/gu, "");
      if (path === "/paid") {
        // The verdict names the check, never a value.
        verdicts.push(`${host}${path}:${ok("cardnumber", card.number) && ok("exp", `${card.month}/${card.year.slice(2)}`) && ok("cvc", card.cvc) && ok("ccname", card.name) ? "ok" : "mismatch"}`);
        return page("Paid", "<h1>결제 완료</h1>");
      }
      if (path === "/approve") {
        const number = ["c1", "c2", "c3", "c4"].map(name => form.get(name) ?? "").join("");
        verdicts.push(`${host}${path}:${number === card.number && form.get("mm") === card.month && form.get("yy") === card.year && ok("pw2", card.pin2) && ok("birth", card.owner) ? "ok" : "mismatch"}`);
        return page("Approved", "<h1>승인 완료</h1>");
      }
      return page("Posted", "<h1>Posted</h1>");
    }
    if (host === "www.fixture-shop.test" && path === "/checkout-cc") return page("Checkout", ccForm("/paid", "59,800원"));
    if (host === "files.fixture-shop.test" && path === "/checkout-cc") return page("Checkout", ccForm("/steal", "59,800원"));
    if (host === "www.fixture-shop.test" && path === "/checkout-pg") return page("Checkout", `<h1>주문 결제</h1><p>결제금액 32,000원</p><iframe id="pg" src="${url("js.tosspayments.com", "/card")}"></iframe>`);
    if (host === "www.fixture-shop.test" && path === "/checkout-keypad") return page("Checkout", `<h1>주문 결제</h1><p>총 결제금액 412,300원</p><iframe id="pg" src="${url("js.tosspayments.com", "/keypad")}"></iframe>`);
    if (host === "www.fixture-shop.test" && path === "/checkout-3ds") return page("Checkout", `<h1>카드 인증</h1><iframe id="acs" src="${url("acs.fixture-bank.test", "/challenge")}"></iframe>`);
    if (host === "www.fixture-shop.test" && path === "/checkout-popup") return page("Checkout", `<h1>주문 결제</h1><p>총 결제금액 18,000원</p>
      <button id="open" onclick="window.open('${url("stdpay.inicis.com", "/pay")}', 'pg', 'width=480,height=640')">결제창 열기</button>`);
    if (host === "stdpay.inicis.com" && path === "/pay") return page("PG", ccForm("/paid", "18,000원"));
    if (host === "js.tosspayments.com" && path === "/card") return page("Card", `<form method="post" action="/approve"><p>카드번호</p>
      ${["c1", "c2", "c3", "c4"].map((name, index) => `<input name="${name}" id="cardNo${index + 1}" maxlength="4" inputmode="numeric" aria-label="카드번호 ${index + 1}">`).join("")}
      <label>유효기간 월 <select name="mm" id="expMonth"><option value="">월</option>${Array.from({ length: 12 }, (_, i) => `<option value="${String(i + 1).padStart(2, "0")}">${i + 1}</option>`).join("")}</select></label>
      <label>유효기간 년 <select name="yy" id="expYear"><option value="">년</option>${Array.from({ length: 10 }, (_, i) => `<option value="${2026 + i}">${2026 + i}</option>`).join("")}</select></label>
      <label>카드 비밀번호 앞 2자리 <input name="pw2" type="password" maxlength="2"></label>
      <label>생년월일 6자리 <input name="birth" maxlength="6" inputmode="numeric"></label>
      <button type="submit">결제하기</button></form>`);
    if (host === "js.tosspayments.com" && path === "/keypad") return page("Card", `<form method="post" action="/approve">
      <label>카드번호 <input name="cardnumber" autocomplete="cc-number"></label>
      <label>카드 비밀번호 앞 2자리 <input name="pw2" class="transkey" type="password" maxlength="2" readonly></label>
      <button type="submit">결제하기</button></form>`);
    if (host === "acs.fixture-bank.test" && path === "/challenge") return page("ACS", `<form method="post" action="/verify"><input type="hidden" name="creq" value="fixture">
      <label>인증번호 <input name="otp" autocomplete="one-time-code" inputmode="numeric"></label><button>확인</button></form>`);
    return new Response("not found", { status: 404 });
  } });
  port = server.port ?? 0;
  return { url, verdicts, stop: () => server.stop(true) };
}

/** Chromium maps the fixture hosts to the local server (connections only). */
export function hostResolverRules(): string {
  return `--host-resolver-rules=${HOSTS.map(host => `MAP ${host} 127.0.0.1`).join(", ")}`;
}

/** Test-only: the guard's DNS pre-check sees a public documentation address for
 * fixture hosts, so the loopback deny stays intact for every other host. */
export function publicResolverPatch(module: string): string {
  return `(() => { const { session } = ${module}('electron'); const proto = Object.getPrototypeOf(session.defaultSession);
    if (proto.__payFixtures) return; proto.__payFixtures = true; const original = proto.resolveHost;
    const hosts = new Set(${JSON.stringify(HOSTS)});
    proto.resolveHost = function (host, options) { return hosts.has(host) ? Promise.resolve({ endpoints: [{ address: "203.0.113.10", family: "ipv4" }] }) : original.call(this, host, options); };
  })()`;
}
