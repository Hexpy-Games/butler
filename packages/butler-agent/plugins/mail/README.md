# 메일

First-party IMAP IDLE and SMTP connector. Build `butler-mail-connector` from
`rust/crates/butler-mail-connector`, then place the executable at
`bin/butler-mail-connector` next to `plugin.json`. App bundle installation is
separate from this package.

Account settings use `BUTLER_CONNECTOR_FIELDS`. Empty optional port, security,
and username fields select the defaults: implicit TLS on 993/465 and the account
address as username. STARTTLS is supported; plaintext requires a literal loopback
IP address. Certificates use native trust roots.

The package declares only `IMAP_PASSWORD` as an account secret. SMTP derives its
password from that secret. Standalone deployments may set `SMTP_PASSWORD` to
override it. Neither secret is stored in connector state or returned by tools. Select the
host system credential store to keep credentials outside the data directory;
the host fallback file backend stores credentials in that directory.

State is scoped by account under `BUTLER_PLUGIN_DATA`. Event IDs encode the
mailbox, UIDVALIDITY and UID. The cursor starts at UIDNEXT on first connection or
a UIDVALIDITY change; subsequent connections catch up. The initial high-water
mark is persisted once, then the cursor advances when events are drained.
A bounded set of Message-IDs records filing intent for returned-mail signals.
The IDLE connection renews every 26 minutes; no mailbox polling runs at idle.

Organize actions use existing folders and never target SPECIAL-USE Trash/Junk.
There is no delete or create-folder tool. Without MOVE, filing requires UIDPLUS
and uses COPY followed by deletion/UID EXPUNGE of only the copied UID. Send,
draft reply and unsubscribe remain outward actions requiring normal host consent.
