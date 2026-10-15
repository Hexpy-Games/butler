// test-category: security
import { expect, test } from "bun:test";
import { agentPopupAllowed } from "../../packages/butler-app/client/electron/browser/popup-policy.mjs";

const policy = { popup_sites: ["example.com"], popup_hosts: ["accounts.google.com", "postcode.map.daum.net"] };
test("popup authority admits inherited blank pages, same site and exact auth/utility hosts", () => {
  for (const target of ["about:blank", "https://shop.example.com/pay", "https://login.example.com/auth", "https://accounts.google.com/auth", "https://postcode.map.daum.net/search"]) {
    expect(agentPopupAllowed(policy, "https://shop.example.com", target)).toBe(true);
  }
});
test("popup authority rejects payments, host lookalikes, credentials and privileged protocols", () => {
  for (const target of ["https://paypal.com/pay", "https://evil-example.com", "https://accounts.google.com.evil.test", "https://evil.accounts.google.com", "https://user:secret@example.com", "file:///etc/passwd", "javascript:alert(1)"]) {
    expect(agentPopupAllowed(policy, "https://shop.example.com", target)).toBe(false);
  }
});
