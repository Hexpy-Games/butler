# One-time external browser login

Implemented against `docs/tunnel-one-time-login.md`.

- Repository-owned tunnel route now consumes hashed, private, ten-minute
  capabilities atomically. GET/HEAD are non-consuming; explicit POST confirmation
  grants the existing secure session cookie. Reusable URL login is disabled.
- File-backed entrypoint replaced the machine-local proxy implementation through
  the existing LaunchAgent. Credentials and session secret were not rotated.
  Only the authentication proxy restarted; the application server PID was unchanged.
- Eleven targeted proxy/login tests passed: concurrent/repeated redemption,
  expired capability, restart persistence, request validation, Basic/session access,
  streaming, bounded HTML handling and typed configuration. Typecheck, focused
  ESLint, architecture audit and diff whitespace checks passed.
- Actual HTTPS domain: first redemption 204; replay 403; issued cookie accesses
  protected application with 200. Real browser confirmation cleared the URL
  fragment and navigated to the Butler application. No user messages were sent.
- Existing Basic credentials and preexisting session cookie both returned 200
  against the deployed candidate before the proxy replacement.

Scope review: no Cloudflare policy change, application restart, global logout or
parallel authentication owner. A local executable backup is retained for rollback.
No credentials or login links are stored in this report. Actual iPad Safari
interaction remains user-confirmed; automated browser verification passed.

Final operator step: issue a fresh link only after validation, without redeeming
the user capability. Link lifetime is ten minutes; session policy remains unchanged.
