import { expect, test } from "bun:test";
import { apiAuth, contentAuth, responseHeaders } from "./auth";

// test-category: security
test("proxy accepts only the current token by query, cookie or API path, and sets the cookie once", () => {
  const token = "T".repeat(43), other = "U".repeat(43);
  expect(contentAuth(token, `/__o/cap/index.html?x=1&bt=${token}`, undefined)).toEqual({ ok: true, path: "/__o/cap/index.html?x=1", setCookie: true });
  expect(contentAuth(token, "/assets/app.js", `a=1; bt=${token}`)).toEqual({ ok: true, path: "/assets/app.js", setCookie: false });
  expect(contentAuth(token, `/assets/app.js?bt=${other}`, `bt=${other}`)).toEqual({ ok: false });
  expect(contentAuth(token, "/assets/app.js", undefined)).toEqual({ ok: false });
  expect(apiAuth(token, `/${token}/message-files/f1`)).toEqual({ ok: true, path: "/message-files/f1", setCookie: false });
  expect(apiAuth(token, `/${other}/message-files/f1`)).toEqual({ ok: false });
  expect(apiAuth(token, `/message-files/f1?bt=${token}`)).toEqual({ ok: false });
  expect(responseHeaders({ "content-type": "text/html", "access-control-allow-origin": "*", "set-cookie": "x=1", connection: "keep-alive" }, token))
    .toEqual({ "content-type": "text/html", "set-cookie": `bt=${token}; HttpOnly; SameSite=Strict; Path=/` });
});
