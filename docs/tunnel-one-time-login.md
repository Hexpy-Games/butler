# Tunnel one-time login

## Approved intent / scope
Issue an iPad browser login link valid for ten minutes and one successful redemption.
Preserve Basic credentials, existing session cookies and the running Butler agent.
The tunnel proxy, not Cloudflare or the model, owns authentication.

## Contract and plan
1. Add a persistent one-time capability store and wire it into the existing tunnel
   login route. Generate 32 random bytes; persist only SHA-256 and expiry in a
   private directory (0700, records 0600). Atomic rename claims a record before
   issuing the existing session cookie. Expired/used/missing tokens fail closed;
   restart cannot resurrect them. No reusable login-token fallback on this route.
2. GET/HEAD only show a confirmation page and never redeem. The URL fragment holds
   the secret, so it is not sent in HTTP URLs, referrers or proxy access logs.
   Explicit confirmation POSTs the token; restrict content type/body size, disallow
   cross-origin requests, use CSP and no-store. Preserve the current seven-day
   session-cookie policy; only the login link expires after ten minutes.
3. Test HTTP redemption, concurrent reuse, expiry, restart persistence, previews,
   invalid requests and existing Basic/session access. Deploy the repository-owned
   proxy through the existing local LaunchAgent; restart only that proxy. Keep a
   local rollback copy. Verify through the actual public domain with a disposable
   test token, then issue a fresh user token without redeeming it.

## Review / non-goals
No Cloudflare policy change, new account system, agent restart, global logout or
UI dashboard change. A crash after claim but before response burns that link;
issue a new link rather than restoring consumed credentials. Login URLs must not
enter tracked reports or source. Public-domain test must establish that the issued
cookie reaches the protected application; a unit-only result is insufficient.

## Completion
Implementation, focused tests, review and deployed public-path validation are
complete; see `reports/tunnel-one-time-login-20260910.md`. User-link issuance is
performed last so validation does not consume its lifetime or capability.
