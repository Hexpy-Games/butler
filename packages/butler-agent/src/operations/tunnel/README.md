# Operational tunnel proxy

The repository-owned tunnel service replaces the historical machine-local auth
proxy. `tunnel-http-proxy.ts` is the public API; the deployable entrypoint is
`tunnel-proxy-cli.ts`, and the native service supervisor starts that entrypoint
when the typed tunnel config is enabled.

## Configure and run

Credentials and the upstream URL are injected through environment variables;
the repository contains no credential files or machine-specific paths.

```sh
BUTLER_DATA="$BUTLER_DATA" \
BUTLER_TUNNEL_PROXY_UPSTREAM="http://127.0.0.1:18765" \
BUTLER_TUNNEL_PROXY_USERNAME="$BUTLER_TUNNEL_USERNAME" \
BUTLER_TUNNEL_PROXY_PASSWORD="$BUTLER_TUNNEL_PASSWORD" \
BUTLER_TUNNEL_PROXY_UPSTREAM_BEARER_TOKEN="$BUTLER_AGENT_TOKEN" \
bun run tunnel:configure

# The native supervisor discovers $BUTLER_DATA/state/tunnel-proxy/config.json.
bun run tunnel:proxy
```

`service-control.sh restart` (and the foreground native service daemon) uses the
same native manifest and therefore starts, watchdogs, and stops this service as
`tunnel-proxy`. The `service-control.sh` path calls `native-service.ts`, whose
restart uses `stopServicesBounded`; it waits for the configured listen port to
be released before removing service state, so restart cannot leave an orphan
listener behind. Removing the config (`bun` can call
`removeTunnelProxyServiceConfig`) disables the service;
the existing external LaunchAgent may be migrated by generating this config and
then restarting the Butler supervisor. The external launch file is intentionally
not modified by this worktree.

The proxy supports optional inbound Basic/session authentication, upstream
bearer injection, a first-run bootstrap response, and bounded HTML rewriting.
Streaming bodies use a `PassThrough` high-water mark, while HTML is buffered only
up to `BUTLER_TUNNEL_PROXY_MAX_HTML_BYTES` (default 2 MiB). Oversized HTML returns
a bounded 502. Downstream abort/close/error, upstream error, and proxy shutdown
destroy both legs and remove the active request exactly once.

The public `tunnel-http-proxy.ts` entrypoint delegates listener ownership to
`tunnel-http-proxy-relay.ts`; request authentication, body policy, and
downstream/upstream teardown are owned by `tunnel-http-proxy-request.ts`. This
keeps one active-request lifecycle owner without a second buffering layer.

## One-time browser login

Set `BUTLER_TUNNEL_PROXY_LOGIN_DIRECTORY` to a private directory and retain the
existing session secret. Issue a ten-minute, single-use link with:

```sh
bun run packages/butler-agent/src/operations/tunnel/tunnel-login-cli.ts /private/login-directory https://your-butler-host
```

The command's output is a credential: deliver it only to the intended user, never
to shared logs. The fragment is cleared from browser history on load. GET/HEAD
previews do not authenticate; the confirmation button POSTs and consumes the
capability. Reusable `login_token` URLs are no longer accepted (the old config
field remains readable for migration). Existing Basic/session access is unchanged.

Installations still using the historical file-backed LaunchAgent can bundle
`tunnel-file-proxy-cli.ts` for Node and replace their proxy executable. It reads
the existing credentials without rotating them, and uses the same repository proxy
and one-time login implementation. Only the proxy needs restarting.
