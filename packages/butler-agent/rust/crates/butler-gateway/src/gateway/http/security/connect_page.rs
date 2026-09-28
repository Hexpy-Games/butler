//! The connection-code screen a browser sees without a session: one field
//! for the code `butler open` prints, and no username/password prompt (no
//! `WWW-Authenticate` challenge).

use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;

const CONTENT_SECURITY_POLICY: &str = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const PAGE_HEAD: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Butler</title>
<style>
:root { color-scheme: light dark; --bg: #f7f7f5; --fg: #1d1d1b; --muted: #6b6b66; --line: #d9d9d4; --accent: #1d1d1b; --accent-fg: #fff; --error: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --bg: #1b1b1a; --fg: #ececea; --muted: #a3a39e; --line: #3a3a37; --accent: #ececea; --accent-fg: #1b1b1a; --error: #f2b8b5; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { width: min(360px, calc(100vw - 32px)); }
h1 { font-size: 20px; margin: 0 0 8px; }
p { margin: 0 0 16px; color: var(--muted); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg); }
label { display: block; font-weight: 600; margin-bottom: 6px; }
input { box-sizing: border-box; width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--fg); font: 16px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.08em; text-transform: uppercase; }
button { margin-top: 12px; width: 100%; padding: 10px 12px; border: 0; border-radius: 8px; background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600; cursor: pointer; }
.error { color: var(--error); }
</style>
</head>
<body>
<main>
<h1>Connect to Butler</h1>
<p>Run <code>butler open</code> in a terminal on this computer, or enter the connection code it shows.</p>
"#;

const PAGE_FORM: &str = r#"<form method="get" action="/connect">
<label for="code">Connection code</label>
<input id="code" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" required autofocus>
<button type="submit">Connect</button>
</form>
</main>
</body>
</html>
"#;

const REJECTED: &str = "<p class=\"error\" role=\"alert\">That code is not valid or has expired. Run <code>butler open</code> for a new one.</p>\n";

/// Why the page is shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::gateway::http) enum ConnectPage {
    /// `GET /connect` with no code: ask for one.
    Ask,
    /// A browser navigation without a session.
    SessionRequired,
    /// A code that is unknown, used or expired.
    Rejected,
}

impl ConnectPage {
    /// The HTML response (never cached, no referrer, not framable).
    pub(in crate::gateway::http) fn response(self) -> Response {
        let notice = if self == Self::Rejected { REJECTED } else { "" };
        let mut response = Response::new(Body::from(format!("{PAGE_HEAD}{notice}{PAGE_FORM}")));
        *response.status_mut() = match self {
            Self::Ask => StatusCode::OK,
            Self::SessionRequired | Self::Rejected => StatusCode::UNAUTHORIZED,
        };
        let headers = response.headers_mut();
        for (name, value) in [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CONTENT_SECURITY_POLICY, CONTENT_SECURITY_POLICY),
        ] {
            headers.insert(name, HeaderValue::from_static(value));
        }
        response
    }
}
