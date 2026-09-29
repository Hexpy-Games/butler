# 05. Remove Telegram support (P1)

**Start from:** `claude/remove-telegram`. The draft PR body has the inventory of Telegram usage.

## Decision
The owner decided on 2026-09-29 to remove Telegram entirely. It was unused, even in the Bun era. The App (local, LAN or tunnel) becomes the only gateway.

## Steps
1. Remove Telegram from:
   - gateway kinds;
   - the CLI (`butler gateway …`);
   - the config schema and credential kinds;
   - doctor checks;
   - delivery routes;
   - transport projection;
   - UI settings and i18n;
   - site docs and README;
   - skills;
   - tests, cassettes and fixtures;
   - any Telegram polling or timers.
2. Leave no dead enum variants or unreachable match arms. Simplify the gateway abstraction only if the change is low-risk.
3. Legacy user data:
   - If `gateways/telegram.json`, a telegram section in `butler.config.json`, or Telegram credentials exist, ignore them at startup and log that once.
   - Never delete user files.
   - Stored schedules or delivery targets that point at Telegram fall back to the App.

## Acceptance
- An E2E starts with a data folder that contains legacy Telegram config and credentials. Startup, `doctor` and `gateway list` all succeed, and only `app` appears.
- A search for "telegram" in shipped code and docs returns nothing. Changelog and history notes may keep it.
